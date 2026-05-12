use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::executor::OperatorCommand;
use crate::journal::{ExecutionJournal, JournalError};
use ethers_core::types::transaction::eip2718::TypedTransaction;
use ethers_core::types::{Address, Bytes, NameOrAddress, TransactionRequest, U256};
use ethers_core::utils::keccak256;
use ethers_signers::{LocalWallet, Signer, WalletError};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

const BPS_DENOMINATOR: u128 = 10_000;
const PANCAKE_V2_FEE_BPS: u128 = 9_975;
const MAX_BUY_TAX_BPS: u16 = 2_500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainExecutionContext {
    pub token_address: String,
    pub vault_address: String,
    pub router_address: String,
    pub owner_address: String,
    pub burn_address: String,
    pub slippage_bps: u16,
    pub deadline_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PairReserves {
    token_reserve: u128,
    bnb_reserve: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmCall {
    pub target: String,
    pub value: u128,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandEncodeError {
    InvalidAddress,
    InvalidHex,
    Unsupported(&'static str),
}

impl fmt::Display for CommandEncodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for CommandEncodeError {}

#[derive(Debug)]
pub enum BscTransactionError {
    Encode(CommandEncodeError),
    Http(reqwest::Error),
    Json(serde_json::Error),
    Rpc(String),
    MissingResult,
    InvalidHex,
    InvalidAmount,
    Wallet(WalletError),
    ReceiptFailed(String),
    ReceiptTimeout(String),
}

impl fmt::Display for BscTransactionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for BscTransactionError {}

impl From<CommandEncodeError> for BscTransactionError {
    fn from(error: CommandEncodeError) -> Self {
        Self::Encode(error)
    }
}

impl From<reqwest::Error> for BscTransactionError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl From<serde_json::Error> for BscTransactionError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<WalletError> for BscTransactionError {
    fn from(error: WalletError) -> Self {
        Self::Wallet(error)
    }
}

pub struct BscTransactionClient {
    http: reqwest::blocking::Client,
    rpc_url: String,
    chain_id: u64,
    wallet: LocalWallet,
    context: ChainExecutionContext,
    gas_limit: u64,
    confirmations: u64,
    receipt_poll_interval: Duration,
    receipt_poll_limit: u32,
}

impl fmt::Debug for BscTransactionClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BscTransactionClient")
            .field("rpc_url", &self.rpc_url)
            .field("chain_id", &self.chain_id)
            .field("wallet", &self.wallet.address())
            .field("context", &self.context)
            .field("gas_limit", &self.gas_limit)
            .field("confirmations", &self.confirmations)
            .finish()
    }
}

impl BscTransactionClient {
    pub fn new(
        rpc_url: impl Into<String>,
        chain_id: u64,
        private_key: &str,
        context: ChainExecutionContext,
        confirmations: u64,
    ) -> Result<Self, BscTransactionError> {
        let wallet = LocalWallet::from_str(private_key)?.with_chain_id(chain_id);
        Ok(Self {
            http: reqwest::blocking::Client::new(),
            rpc_url: rpc_url.into(),
            chain_id,
            wallet,
            context,
            gas_limit: 600_000,
            confirmations: confirmations.max(1),
            receipt_poll_interval: Duration::from_secs(3),
            receipt_poll_limit: 120,
        })
    }

    pub fn with_gas_limit(mut self, gas_limit: u64) -> Self {
        self.gas_limit = gas_limit;
        self
    }

    pub fn with_receipt_polling(mut self, interval: Duration, limit: u32) -> Self {
        self.receipt_poll_interval = interval;
        self.receipt_poll_limit = limit.max(1);
        self
    }

    pub fn wallet_address(&self) -> Address {
        self.wallet.address()
    }

    fn submit_add_liquidity(
        &mut self,
        bnb_amount: u128,
        token_value_bnb: u128,
    ) -> Result<String, BscTransactionError> {
        let reserves = self.pair_reserves()?;
        if token_value_bnb == 0 {
            return Err(BscTransactionError::InvalidAmount);
        }
        let token_amount = quote_synced_pull_token_amount(bnb_amount, &reserves)?;
        let bnb_min = apply_slippage(bnb_amount, self.context.slippage_bps)?;
        let router = self.context.router_address.clone();
        let token = self.context.token_address.clone();

        // `pullPairTokensExact` syncs the Pair after removing tokens, so the
        // amount to pull must be solved against the post-pull reserve. For
        // BNB amount x and reserves T/B, pull p = x*T/(B+x); after sync the
        // router's optimal token side for x BNB is p again.
        let pull =
            encode_function_calldata("pullPairTokensExact(uint256)", &[u256_word(token_amount)])?;
        let pull_hash = self.submit_evm_call(EvmCall {
            target: token.clone(),
            value: 0,
            data: format!("0x{}", hex_encode(&pull)),
        })?;

        let post_pull_reserves = self.pair_reserves()?;
        let router_token_amount = quote_token_amount(bnb_amount, &post_pull_reserves)?;
        let token_min = apply_slippage(
            router_token_amount.min(token_amount),
            self.context.slippage_bps,
        )?;

        let approve = encode_function_calldata(
            "approve(address,uint256)",
            &[
                address_word(&normalize_address(&router)?),
                u256_word(token_amount),
            ],
        )?;
        let approve_hash = self.submit_operator_call(&token, 0, &approve)?;
        let add_liquidity = encode_function_calldata(
            "addLiquidityETH(address,uint256,uint256,uint256,address,uint256)",
            &[
                address_word(&normalize_address(&token)?),
                u256_word(token_amount),
                u256_word(token_min),
                u256_word(bnb_min),
                address_word(&normalize_address(&token)?),
                u256_word(self.deadline()?),
            ],
        )?;
        let liquidity_hash = self.submit_operator_call(&router, bnb_amount, &add_liquidity)?;
        Ok(format!("{pull_hash},{approve_hash},{liquidity_hash}"))
    }

    fn submit_builder_buy(&mut self, bnb_amount: u128) -> Result<String, BscTransactionError> {
        let reserves = self.pair_reserves()?;
        let token_out = v2_amount_out(bnb_amount, reserves.bnb_reserve, reserves.token_reserve)?;
        let amount_out_min = apply_slippage(token_out, self.context.slippage_bps)?;
        let router = self.context.router_address.clone();
        let weth = self.weth_address()?;
        let token = self.context.token_address.clone();
        let operator = format!("{:#x}", self.wallet.address());
        let before = self.erc20_balance_of(&token, &operator)?;

        // Pancake V2 Pair rejects swap recipients equal to token0/token1.
        // Buy into the operator wallet first, then transfer the received
        // project tokens back into token self-custody as builder inventory.
        let swap = encode_swap_exact_eth_for_tokens(
            amount_out_min,
            &weth,
            &token,
            &operator,
            self.deadline()?,
        )?;
        let swap_hash = self.submit_operator_call(&router, bnb_amount, &swap)?;
        let after = self.erc20_balance_of(&token, &operator)?;
        let received = after
            .checked_sub(before)
            .ok_or(BscTransactionError::InvalidAmount)?;
        if received == 0 {
            return Err(BscTransactionError::InvalidAmount);
        }
        let transfer = encode_function_calldata(
            "transfer(address,uint256)",
            &[
                address_word(&normalize_address(&token)?),
                u256_word(received),
            ],
        )?;
        let transfer_hash = self.submit_evm_call(EvmCall {
            target: token,
            value: 0,
            data: format!("0x{}", hex_encode(&transfer)),
        })?;
        Ok(format!("{swap_hash},{transfer_hash}"))
    }

    fn submit_buyback(&mut self, bnb_amount: u128) -> Result<String, BscTransactionError> {
        let reserves = self.pair_reserves()?;
        let token_out = v2_amount_out(bnb_amount, reserves.bnb_reserve, reserves.token_reserve)?;
        let min_after_slippage = apply_slippage(token_out, self.context.slippage_bps)?;
        let amount_out_min = apply_slippage(min_after_slippage, MAX_BUY_TAX_BPS)?;
        let router = self.context.router_address.clone();
        let vault = self.context.vault_address.clone();
        let weth = self.weth_address()?;
        let token = self.context.token_address.clone();
        let burn = self.context.burn_address.clone();
        let swap = encode_swap_exact_eth_for_tokens(
            amount_out_min,
            &weth,
            &token,
            &burn,
            self.deadline()?,
        )?;
        let vault_execute = encode_dynamic_bytes_call(
            "execute(address,uint256,bytes)",
            &router,
            bnb_amount,
            &swap,
        )?;
        let vault_execute = decode_hex_bytes(&vault_execute)?;
        self.submit_operator_call(&vault, 0, &vault_execute)
    }

    fn submit_reward_token(
        &mut self,
        to: &str,
        amount: u128,
    ) -> Result<String, BscTransactionError> {
        let reserves = self.pair_reserves()?;
        let token_amount = quote_token_amount(amount, &reserves)?;
        let token = self.context.token_address.clone();
        let transfer = encode_function_calldata(
            "transfer(address,uint256)",
            &[
                address_word(&normalize_address(to)?),
                u256_word(token_amount),
            ],
        )?;
        self.submit_operator_call(&token, 0, &transfer)
    }

    fn submit_burn_token_by_bnb_value(
        &mut self,
        amount: u128,
    ) -> Result<String, BscTransactionError> {
        let reserves = self.pair_reserves()?;
        let burn_amount = quote_token_amount(amount, &reserves)?;
        let token = self.context.token_address.clone();
        let burn = encode_burn_call(burn_amount)?;
        self.submit_operator_call(&token, 0, &burn)
    }

    /// Sweep `tax_token_amount` tokens that have accumulated in the token
    /// contract's self-custody (from buy/sell tax) by orchestrating, via
    /// `operatorCall`, the sequence:
    ///   1. token.approve(router, sell_amount)
    ///   2. token.burn(burn_token_amount) — sends to zero address
    ///   3. router.swapExactTokensForETHSupportingFeeOnTransferTokens(...)
    ///   4. token.operatorCall(owner, ownerBnb, "")
    ///   5. token.operatorCall(vault, vaultBnb, "")
    /// All steps are individual transactions sharing the same idempotency
    /// batch tag from the journal. We compute the expected BNB output up
    /// front from current pair reserves so the swap can supply a sane
    /// `amountOutMin`.
    fn submit_sweep_tax_to_bnb(
        &mut self,
        tax_token_amount: u128,
        builder_token_amount: u128,
        burn_token_amount: u128,
        owner_bnb_bps_of_sold: u16,
        vault_bnb_bps_of_sold: u16,
    ) -> Result<String, BscTransactionError> {
        if tax_token_amount == 0
            || builder_token_amount.saturating_add(burn_token_amount) > tax_token_amount
            || u32::from(owner_bnb_bps_of_sold) + u32::from(vault_bnb_bps_of_sold)
                > BPS_DENOMINATOR as u32
        {
            return Err(BscTransactionError::InvalidAmount);
        }
        let sell_amount = tax_token_amount
            .saturating_sub(builder_token_amount)
            .saturating_sub(burn_token_amount);
        let token = self.context.token_address.clone();
        let router = self.context.router_address.clone();
        let weth = self.weth_address()?;

        let mut hashes: Vec<String> = Vec::new();

        if burn_token_amount != 0 {
            let burn = encode_burn_call(burn_token_amount)?;
            hashes.push(self.submit_operator_call(&token, 0, &burn)?);
        }

        if sell_amount != 0 {
            // approve(router, sell_amount) — token contract is msg.sender, so
            // we route through operatorCall(token, 0, approve(router, amount)).
            let approve = encode_function_calldata(
                "approve(address,uint256)",
                &[
                    address_word(&normalize_address(&router)?),
                    u256_word(sell_amount),
                ],
            )?;
            hashes.push(self.submit_operator_call(&token, 0, &approve)?);

            let reserves = self.pair_reserves()?;
            // selling tokens for BNB → input reserve is token, output is BNB.
            let bnb_out = v2_amount_out(sell_amount, reserves.token_reserve, reserves.bnb_reserve)?;
            let amount_out_min = apply_slippage(bnb_out, self.context.slippage_bps)?;
            let swap = encode_swap_exact_tokens_for_eth(
                sell_amount,
                amount_out_min,
                &token,
                &weth,
                &token, // BNB lands back in the token contract for routing.
                self.deadline()?,
            )?;
            hashes.push(self.submit_operator_call(&router, 0, &swap)?);

            // Forward the freshly-received BNB. We split on the *expected*
            // gross output because the contract sees only its own balance;
            // residual dust stays in the contract for the next sweep.
            let owner_amt = (U256::from(bnb_out)
                .saturating_mul(U256::from(owner_bnb_bps_of_sold as u128))
                / U256::from(10_000u128))
            .as_u128();
            let vault_amt = (U256::from(bnb_out)
                .saturating_mul(U256::from(vault_bnb_bps_of_sold as u128))
                / U256::from(10_000u128))
            .as_u128();
            if owner_amt != 0 {
                let owner_addr = self.context.owner_address.clone();
                let fwd = encode_operator_call(&owner_addr, owner_amt, &[])?;
                let fwd_bytes = decode_hex_bytes(&fwd)?;
                hashes.push(self.submit_operator_call(&token, 0, &fwd_bytes)?);
            }
            if vault_amt != 0 {
                let vault_addr = self.context.vault_address.clone();
                let fwd = encode_operator_call(&vault_addr, vault_amt, &[])?;
                let fwd_bytes = decode_hex_bytes(&fwd)?;
                hashes.push(self.submit_operator_call(&token, 0, &fwd_bytes)?);
            }
        }

        Ok(hashes.join(","))
    }

    fn submit_redeem_user_lp(
        &mut self,
        user: &str,
        lp_bnb_share: u128,
        total_active_principal: u128,
    ) -> Result<String, BscTransactionError> {
        if lp_bnb_share == 0 || total_active_principal == 0 {
            return Err(BscTransactionError::InvalidAmount);
        }
        if lp_bnb_share > total_active_principal {
            // Stale denominator: refuse rather than over-redeem.
            return Err(BscTransactionError::Rpc(
                "lp share exceeds active principal denominator".to_owned(),
            ));
        }
        let token = self.context.token_address.clone();
        let pair_address = self.pair_address()?;
        let pair_balance = self.pair_balance_of(&pair_address, &token)?;
        if pair_balance == 0 {
            return Err(BscTransactionError::Rpc(
                "token contract has no LP custody".to_owned(),
            ));
        }
        let pair_total_supply = self.pair_total_supply(&pair_address)?;
        let reserves = self.pair_reserves()?;
        if pair_total_supply == 0 || reserves.bnb_reserve == 0 {
            return Err(BscTransactionError::InvalidAmount);
        }
        // Fraction-based formula: the contract holds `pair_balance` LP for all
        // active users combined; this user owns `share / total` of that
        // custody. The result is independent of current BNB price.
        let lp_to_remove = U256::from(pair_balance)
            .saturating_mul(U256::from(lp_bnb_share))
            .checked_div(U256::from(total_active_principal))
            .ok_or(BscTransactionError::InvalidAmount)?;
        let lp_to_remove = u256_to_u128(lp_to_remove)?.min(pair_balance);
        if lp_to_remove == 0 {
            return Err(BscTransactionError::InvalidAmount);
        }
        // BNB-side safety check: estimate the BNB the user will receive
        // (`lp_to_remove × bnb_reserve / total_supply`) and refuse if the
        // pair clearly cannot honour the redemption. This catches the
        // "everyone exits at the same instant" cascade and the
        // "impermanent-loss undershoot" case before we burn user LP.
        let expected_bnb_out = U256::from(lp_to_remove)
            .saturating_mul(U256::from(reserves.bnb_reserve))
            .checked_div(U256::from(pair_total_supply))
            .ok_or(BscTransactionError::InvalidAmount)?;
        let expected_bnb_out = u256_to_u128(expected_bnb_out)?;
        if expected_bnb_out == 0 {
            return Err(BscTransactionError::Rpc(
                "pair BNB reserve would return zero refund".to_owned(),
            ));
        }
        // Hard floor: if the user would receive less than half of their LP
        // BNB principal we bail out and surface a "LP_RESERVE_INSUFFICIENT"
        // signal via the journal instead of silently under-paying.
        let floor = lp_bnb_share / 2;
        if expected_bnb_out < floor {
            return Err(BscTransactionError::Rpc(format!(
                "LP_RESERVE_INSUFFICIENT: expected_bnb_out={expected_bnb_out} < floor={floor}"
            )));
        }
        let redeem = encode_function_calldata(
            "operatorRedeemLp(address,uint256)",
            &[
                address_word(&normalize_address(user)?),
                u256_word(lp_to_remove),
            ],
        )?;
        // operatorRedeemLp is a direct method on the token contract; the
        // operator wallet is privileged via the `onlyOperator` modifier so we
        // call it directly rather than going through `operatorCall`.
        self.submit_evm_call(EvmCall {
            target: token,
            value: 0,
            data: format!("0x{}", hex_encode(&redeem)),
        })
    }

    fn pair_address(&self) -> Result<String, BscTransactionError> {
        let token = normalize_address(&self.context.token_address)?;
        let pair = parse_address_word(&self.eth_call_to(&token, &function_selector("pair()"))?)?;
        if pair == "0x0000000000000000000000000000000000000000" {
            return Err(BscTransactionError::Rpc(
                "pair is not initialized".to_owned(),
            ));
        }
        Ok(pair)
    }

    fn pair_balance_of(&self, pair: &str, account: &str) -> Result<u128, BscTransactionError> {
        self.erc20_balance_of(pair, account)
    }

    fn erc20_balance_of(&self, token: &str, account: &str) -> Result<u128, BscTransactionError> {
        let mut data = function_selector("balanceOf(address)");
        data.push_str(&address_word(&normalize_address(account)?));
        let result = self.eth_call_to(token, &data)?;
        parse_u128_word(&result, 0)
    }

    fn pair_total_supply(&self, pair: &str) -> Result<u128, BscTransactionError> {
        let result = self.eth_call_to(pair, &function_selector("totalSupply()"))?;
        parse_u128_word(&result, 0)
    }

    fn submit_operator_call(
        &mut self,
        target: &str,
        value: u128,
        data: &[u8],
    ) -> Result<String, BscTransactionError> {
        let token = normalize_address(&self.context.token_address)?;
        self.submit_evm_call(EvmCall {
            target: token,
            value: 0,
            data: encode_operator_call(target, value, data)?,
        })
    }

    fn pair_reserves(&self) -> Result<PairReserves, BscTransactionError> {
        let token = normalize_address(&self.context.token_address)?;
        let pair = parse_address_word(&self.eth_call_to(&token, &function_selector("pair()"))?)?;
        if pair == "0x0000000000000000000000000000000000000000" {
            return Err(BscTransactionError::Rpc(
                "pair is not initialized".to_owned(),
            ));
        }
        let token0 = parse_address_word(&self.eth_call_to(&pair, &function_selector("token0()"))?)?;
        let reserves = self.eth_call_to(&pair, &function_selector("getReserves()"))?;
        let reserve0 = parse_u128_word(&reserves, 0)?;
        let reserve1 = parse_u128_word(&reserves, 1)?;
        let (token_reserve, bnb_reserve) = if token0 == token {
            (reserve0, reserve1)
        } else {
            (reserve1, reserve0)
        };
        Ok(PairReserves {
            token_reserve,
            bnb_reserve,
        })
    }

    fn weth_address(&self) -> Result<String, BscTransactionError> {
        let router = normalize_address(&self.context.router_address)?;
        parse_address_word(&self.eth_call_to(&router, &function_selector("WETH()"))?)
    }

    fn deadline(&self) -> Result<u128, BscTransactionError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| BscTransactionError::InvalidAmount)?
            .as_secs();
        Ok(u128::from(
            now.saturating_add(self.context.deadline_seconds),
        ))
    }

    pub fn submit_evm_call(&mut self, call: EvmCall) -> Result<String, BscTransactionError> {
        let target = parse_address(&call.target)?;
        let nonce = self.transaction_count()?;
        let gas_price = self.gas_price()?;
        let data = decode_hex_bytes(&call.data)?;
        let request = TransactionRequest::new()
            .from(self.wallet.address())
            .to(NameOrAddress::Address(target))
            .value(U256::from(call.value))
            .data(Bytes::from(data))
            .nonce(nonce)
            .gas(U256::from(self.gas_limit))
            .gas_price(gas_price)
            .chain_id(self.chain_id);
        let transaction: TypedTransaction = request.into();
        let signature = self.wallet.sign_transaction_sync(&transaction)?;
        let raw = transaction.rlp_signed(&signature);
        let tx_hash: String = self.rpc(
            "eth_sendRawTransaction",
            vec![serde_json::Value::String(format!(
                "0x{}",
                hex_encode(raw.as_ref())
            ))],
        )?;
        self.wait_for_confirmed_receipt(&tx_hash)?;
        Ok(tx_hash)
    }

    fn transaction_count(&self) -> Result<U256, BscTransactionError> {
        let nonce: String = self.rpc(
            "eth_getTransactionCount",
            vec![
                serde_json::Value::String(format!("{:#x}", self.wallet.address())),
                serde_json::Value::String("pending".to_owned()),
            ],
        )?;
        parse_u256_hex(&nonce)
    }

    fn gas_price(&self) -> Result<U256, BscTransactionError> {
        let gas_price: String = self.rpc("eth_gasPrice", Vec::<serde_json::Value>::new())?;
        parse_u256_hex(&gas_price)
    }

    fn block_number(&self) -> Result<u64, BscTransactionError> {
        let block_number: String = self.rpc("eth_blockNumber", Vec::<serde_json::Value>::new())?;
        parse_u64_hex(&block_number)
    }

    fn eth_call_to(&self, target: &str, data: &str) -> Result<String, BscTransactionError> {
        let target = normalize_address(target)?;
        let call = serde_json::json!({
            "to": target,
            "data": data,
        });
        self.rpc(
            "eth_call",
            vec![call, serde_json::Value::String("latest".to_owned())],
        )
    }

    fn wait_for_confirmed_receipt(&self, tx_hash: &str) -> Result<(), BscTransactionError> {
        for _ in 0..self.receipt_poll_limit {
            let receipt: Option<TransactionReceipt> = self.rpc_optional(
                "eth_getTransactionReceipt",
                vec![serde_json::Value::String(tx_hash.to_owned())],
            )?;
            if let Some(receipt) = receipt {
                if receipt.status.as_deref() != Some("0x1") {
                    return Err(BscTransactionError::ReceiptFailed(tx_hash.to_owned()));
                }
                let receipt_block = parse_u64_hex(&receipt.block_number)?;
                let target = receipt_block.saturating_add(self.confirmations.saturating_sub(1));
                if self.block_number()? >= target {
                    return Ok(());
                }
            }
            thread::sleep(self.receipt_poll_interval);
        }
        Err(BscTransactionError::ReceiptTimeout(tx_hash.to_owned()))
    }

    fn rpc<T: DeserializeOwned>(
        &self,
        method: &'static str,
        params: Vec<serde_json::Value>,
    ) -> Result<T, BscTransactionError> {
        let response = self
            .http
            .post(&self.rpc_url)
            .json(&JsonRpcRequest {
                jsonrpc: "2.0",
                id: 1,
                method,
                params,
            })
            .send()?
            .error_for_status()?
            .json::<JsonRpcResponse>()?;
        if let Some(error) = response.error {
            return Err(BscTransactionError::Rpc(error.message));
        }
        if response.result.is_null() {
            return Err(BscTransactionError::MissingResult);
        }
        serde_json::from_value(response.result).map_err(BscTransactionError::Json)
    }

    fn rpc_optional<T: DeserializeOwned>(
        &self,
        method: &'static str,
        params: Vec<serde_json::Value>,
    ) -> Result<Option<T>, BscTransactionError> {
        let response = self
            .http
            .post(&self.rpc_url)
            .json(&JsonRpcRequest {
                jsonrpc: "2.0",
                id: 1,
                method,
                params,
            })
            .send()?
            .error_for_status()?
            .json::<JsonRpcResponse>()?;
        if let Some(error) = response.error {
            return Err(BscTransactionError::Rpc(error.message));
        }
        if response.result.is_null() {
            return Ok(None);
        }
        serde_json::from_value(response.result)
            .map(Some)
            .map_err(BscTransactionError::Json)
    }
}

impl ChainClient for BscTransactionClient {
    type Error = BscTransactionError;

    fn submit(&mut self, command: &OperatorCommand) -> Result<String, Self::Error> {
        match command {
            OperatorCommand::AddLiquidity {
                bnb_amount,
                token_value_bnb,
            } => self.submit_add_liquidity(*bnb_amount, *token_value_bnb),
            OperatorCommand::BuilderBuy { bnb_amount } => self.submit_builder_buy(*bnb_amount),
            OperatorCommand::Buyback { bnb_amount } => self.submit_buyback(*bnb_amount),
            OperatorCommand::PayRewardTokenByBnbValue { to, amount } => {
                self.submit_reward_token(to, *amount)
            }
            OperatorCommand::BurnTokenByBnbValue { amount, .. } => {
                self.submit_burn_token_by_bnb_value(*amount)
            }
            OperatorCommand::RedeemUserLp {
                user,
                lp_bnb_share,
                total_active_principal,
            } => self.submit_redeem_user_lp(user, *lp_bnb_share, *total_active_principal),
            OperatorCommand::SweepTaxToBnb {
                tax_token_amount,
                builder_token_amount,
                burn_token_amount,
                owner_bnb_bps_of_sold,
                vault_bnb_bps_of_sold,
            } => self.submit_sweep_tax_to_bnb(
                *tax_token_amount,
                *builder_token_amount,
                *burn_token_amount,
                *owner_bnb_bps_of_sold,
                *vault_bnb_bps_of_sold,
            ),
            OperatorCommand::ExitPosition { .. } => Err(CommandEncodeError::Unsupported(
                "legacy exit-position is replaced by separate burn/refund commands",
            )
            .into()),
            OperatorCommand::TransferBnb { .. }
            | OperatorCommand::CreditVault { .. }
            | OperatorCommand::PullPairTokens { .. } => {
                let call = encode_command_call(&self.context, command)?;
                self.submit_evm_call(call)
            }
        }
    }
}

pub trait ChainClient {
    type Error;

    fn submit(&mut self, command: &OperatorCommand) -> Result<String, Self::Error>;
}

#[derive(Debug, Default, Clone)]
pub struct RecordedClient {
    pub submitted: Vec<OperatorCommand>,
}

impl ChainClient for RecordedClient {
    type Error = Infallible;

    fn submit(&mut self, command: &OperatorCommand) -> Result<String, Self::Error> {
        self.submitted.push(command.clone());
        Ok(format!("local-tx-{}", self.submitted.len()))
    }
}

pub fn submit_all<C: ChainClient>(
    client: &mut C,
    commands: &[OperatorCommand],
) -> Result<Vec<String>, C::Error> {
    commands
        .iter()
        .map(|command| client.submit(command))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitPendingError<E> {
    Chain(E),
    Journal(JournalError),
}

pub fn submit_pending<C>(
    client: &mut C,
    journal: &mut ExecutionJournal,
) -> Result<Vec<String>, SubmitPendingError<C::Error>>
where
    C: ChainClient,
    C::Error: fmt::Debug,
{
    let pending = journal.pending_commands();
    let mut tx_hashes = Vec::new();
    for (id, command) in pending {
        let tx_hash = match client.submit(&command) {
            Ok(tx_hash) => tx_hash,
            Err(error) => {
                let message = format!("{error:?}");
                journal
                    .mark_failed(&id, message)
                    .map_err(SubmitPendingError::Journal)?;
                return Err(SubmitPendingError::Chain(error));
            }
        };
        journal
            .mark_submitted(&id, tx_hash.clone())
            .map_err(SubmitPendingError::Journal)?;
        journal
            .mark_confirmed(&id)
            .map_err(SubmitPendingError::Journal)?;
        tx_hashes.push(tx_hash);
    }
    Ok(tx_hashes)
}

pub fn encode_command_call(
    context: &ChainExecutionContext,
    command: &OperatorCommand,
) -> Result<EvmCall, CommandEncodeError> {
    let token = normalize_address(&context.token_address)?;
    let vault = normalize_address(&context.vault_address)?;
    match command {
        OperatorCommand::TransferBnb { to, amount, .. } => Ok(EvmCall {
            target: token.clone(),
            value: 0,
            data: encode_operator_call(to, *amount, &[])?,
        }),
        OperatorCommand::CreditVault { amount } => Ok(EvmCall {
            target: token.clone(),
            value: 0,
            data: encode_operator_call(&vault, *amount, &[])?,
        }),
        OperatorCommand::PullPairTokens { bps } => Ok(EvmCall {
            target: token,
            value: 0,
            data: encode_function_call("pullPairTokens(uint16)", &[u256_word(u128::from(*bps))]),
        }),
        OperatorCommand::AddLiquidity { .. } => Err(CommandEncodeError::Unsupported(
            "add-liquidity requires pair quote and router calldata",
        )),
        OperatorCommand::BuilderBuy { .. } => Err(CommandEncodeError::Unsupported(
            "builder-buy requires swap path and slippage limits",
        )),
        OperatorCommand::Buyback { .. } => Err(CommandEncodeError::Unsupported(
            "buyback requires vault router calldata and burn target",
        )),
        OperatorCommand::PayRewardTokenByBnbValue { .. } => Err(CommandEncodeError::Unsupported(
            "reward payout requires token amount quote at execution time",
        )),
        OperatorCommand::BurnTokenByBnbValue { .. } => Err(CommandEncodeError::Unsupported(
            "token burn requires token amount quote at execution time",
        )),
        OperatorCommand::RedeemUserLp { .. } => Err(CommandEncodeError::Unsupported(
            "redeem-user-lp requires live pair reserves and totalSupply",
        )),
        OperatorCommand::SweepTaxToBnb { .. } => Err(CommandEncodeError::Unsupported(
            "sweep-tax requires live pair reserves and is orchestrated as a multi-tx batch",
        )),
        OperatorCommand::ExitPosition { .. } => Err(CommandEncodeError::Unsupported(
            "legacy exit-position is replaced by separate burn/refund commands",
        )),
    }
}

fn encode_operator_call(
    target: &str,
    value: u128,
    data: &[u8],
) -> Result<String, CommandEncodeError> {
    encode_dynamic_bytes_call("operatorCall(address,uint256,bytes)", target, value, data)
}

fn encode_dynamic_bytes_call(
    signature: &str,
    target: &str,
    value: u128,
    data: &[u8],
) -> Result<String, CommandEncodeError> {
    let target = normalize_address(target)?;
    let mut words = vec![address_word(&target), u256_word(value), u256_word(96)];
    words.push(u256_word(data.len() as u128));
    let encoded_data = hex_encode(data);
    if !encoded_data.is_empty() {
        words.push(pad_right_word(&encoded_data));
    }
    Ok(encode_function_call(signature, &words))
}

fn encode_function_calldata(
    signature: &str,
    words: &[String],
) -> Result<Vec<u8>, CommandEncodeError> {
    decode_hex_bytes(&encode_function_call(signature, words))
}

fn encode_swap_exact_eth_for_tokens(
    amount_out_min: u128,
    weth: &str,
    token: &str,
    to: &str,
    deadline: u128,
) -> Result<Vec<u8>, CommandEncodeError> {
    decode_hex_bytes(&encode_function_call(
        "swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)",
        &[
            u256_word(amount_out_min),
            u256_word(128),
            address_word(&normalize_address(to)?),
            u256_word(deadline),
            u256_word(2),
            address_word(&normalize_address(weth)?),
            address_word(&normalize_address(token)?),
        ],
    ))
}

fn encode_burn_call(amount: u128) -> Result<Vec<u8>, CommandEncodeError> {
    encode_function_calldata("burn(uint256)", &[u256_word(amount)])
}

fn encode_swap_exact_tokens_for_eth(
    amount_in: u128,
    amount_out_min: u128,
    token: &str,
    weth: &str,
    to: &str,
    deadline: u128,
) -> Result<Vec<u8>, CommandEncodeError> {
    decode_hex_bytes(&encode_function_call(
        "swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
        &[
            u256_word(amount_in),
            u256_word(amount_out_min),
            u256_word(160),
            address_word(&normalize_address(to)?),
            u256_word(deadline),
            u256_word(2),
            address_word(&normalize_address(token)?),
            address_word(&normalize_address(weth)?),
        ],
    ))
}

fn encode_function_call(signature: &str, words: &[String]) -> String {
    let mut output = function_selector(signature);
    for word in words {
        output.push_str(word);
    }
    output
}

fn function_selector(signature: &str) -> String {
    format!("0x{}", &hex_encode(&keccak256(signature.as_bytes()))[..8])
}

fn normalize_address(address: &str) -> Result<String, CommandEncodeError> {
    let value = address
        .trim()
        .strip_prefix("0x")
        .ok_or(CommandEncodeError::InvalidAddress)?;
    if value.len() != 40 || !value.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(CommandEncodeError::InvalidAddress);
    }
    Ok(format!("0x{}", value.to_ascii_lowercase()))
}

fn parse_address(address: &str) -> Result<Address, CommandEncodeError> {
    let value = normalize_address(address)?;
    Address::from_str(&value).map_err(|_| CommandEncodeError::InvalidAddress)
}

fn address_word(address: &str) -> String {
    format!("{:0>64}", address.trim_start_matches("0x"))
}

fn u256_word(value: u128) -> String {
    format!("{:032x}{:032x}", 0u128, value)
}

fn pad_right_word(value: &str) -> String {
    let mut output = value.to_owned();
    while !output.len().is_multiple_of(64) {
        output.push('0');
    }
    output
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex_bytes(value: &str) -> Result<Vec<u8>, CommandEncodeError> {
    let value = value
        .strip_prefix("0x")
        .ok_or(CommandEncodeError::InvalidHex)?;
    if !value.len().is_multiple_of(2) || !value.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(CommandEncodeError::InvalidHex);
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for index in (0..value.len()).step_by(2) {
        bytes.push(
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| CommandEncodeError::InvalidHex)?,
        );
    }
    Ok(bytes)
}

fn parse_address_word(value: &str) -> Result<String, BscTransactionError> {
    let word = value
        .trim()
        .strip_prefix("0x")
        .ok_or(BscTransactionError::InvalidHex)?;
    if word.len() != 64 || !word.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(BscTransactionError::InvalidHex);
    }
    Ok(format!("0x{}", word[24..].to_ascii_lowercase()))
}

fn parse_u128_word(value: &str, index: usize) -> Result<u128, BscTransactionError> {
    let trimmed = value
        .trim()
        .strip_prefix("0x")
        .ok_or(BscTransactionError::InvalidHex)?;
    let start = index
        .checked_mul(64)
        .ok_or(BscTransactionError::InvalidHex)?;
    let end = start
        .checked_add(64)
        .ok_or(BscTransactionError::InvalidHex)?;
    let word = trimmed
        .get(start..end)
        .ok_or(BscTransactionError::InvalidHex)?;
    if !word.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(BscTransactionError::InvalidHex);
    }
    if word[..32].chars().any(|char| char != '0') {
        return Err(BscTransactionError::InvalidAmount);
    }
    u128::from_str_radix(&word[32..], 16).map_err(|_| BscTransactionError::InvalidHex)
}

fn quote_token_amount(
    bnb_value: u128,
    reserves: &PairReserves,
) -> Result<u128, BscTransactionError> {
    if bnb_value == 0 || reserves.bnb_reserve == 0 || reserves.token_reserve == 0 {
        return Err(BscTransactionError::InvalidAmount);
    }
    u256_to_u128(
        U256::from(bnb_value) * U256::from(reserves.token_reserve)
            / U256::from(reserves.bnb_reserve),
    )
}

fn quote_synced_pull_token_amount(
    bnb_value: u128,
    reserves: &PairReserves,
) -> Result<u128, BscTransactionError> {
    if bnb_value == 0 || reserves.bnb_reserve == 0 || reserves.token_reserve == 0 {
        return Err(BscTransactionError::InvalidAmount);
    }
    let numerator = U256::from(bnb_value) * U256::from(reserves.token_reserve);
    let denominator = U256::from(reserves.bnb_reserve) + U256::from(bnb_value);
    u256_to_u128((numerator + denominator - U256::from(1u8)) / denominator)
}

fn v2_amount_out(
    amount_in: u128,
    reserve_in: u128,
    reserve_out: u128,
) -> Result<u128, BscTransactionError> {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return Err(BscTransactionError::InvalidAmount);
    }
    let amount_in_with_fee = U256::from(amount_in) * U256::from(PANCAKE_V2_FEE_BPS);
    let numerator = amount_in_with_fee * U256::from(reserve_out);
    let denominator = U256::from(reserve_in) * U256::from(BPS_DENOMINATOR) + amount_in_with_fee;
    u256_to_u128(numerator / denominator)
}

fn apply_slippage(amount: u128, slippage_bps: u16) -> Result<u128, BscTransactionError> {
    if u128::from(slippage_bps) > BPS_DENOMINATOR {
        return Err(BscTransactionError::InvalidAmount);
    }
    Ok(amount.saturating_mul(BPS_DENOMINATOR - u128::from(slippage_bps)) / BPS_DENOMINATOR)
}

fn u256_to_u128(value: U256) -> Result<u128, BscTransactionError> {
    if value > U256::from(u128::MAX) {
        return Err(BscTransactionError::InvalidAmount);
    }
    Ok(value.as_u128())
}

fn parse_u64_hex(value: &str) -> Result<u64, BscTransactionError> {
    u64::from_str_radix(value.trim_start_matches("0x"), 16)
        .map_err(|_| BscTransactionError::InvalidHex)
}

fn parse_u256_hex(value: &str) -> Result<U256, BscTransactionError> {
    U256::from_str_radix(value.trim_start_matches("0x"), 16)
        .map_err(|_| BscTransactionError::InvalidHex)
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest<P> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: P,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[serde(default)]
    result: serde_json::Value,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionReceipt {
    block_number: String,
    status: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::CommandStatus;

    #[test]
    fn recorded_client_keeps_submission_order() {
        let mut client = RecordedClient::default();
        let commands = vec![
            OperatorCommand::CreditVault { amount: 1 },
            OperatorCommand::Buyback { bnb_amount: 1 },
        ];
        let hashes = submit_all(&mut client, &commands).unwrap();
        assert_eq!(hashes, vec!["local-tx-1", "local-tx-2"]);
        assert_eq!(client.submitted, commands);
    }

    #[test]
    fn submit_pending_skips_confirmed_commands() {
        let mut client = RecordedClient::default();
        let mut journal = ExecutionJournal::default();
        let ids = journal.plan_batch(
            "deposit:tx1:0",
            vec![
                OperatorCommand::CreditVault { amount: 1 },
                OperatorCommand::Buyback { bnb_amount: 2 },
            ],
        );
        journal.mark_submitted(&ids[0], "0x1").unwrap();
        journal.mark_confirmed(&ids[0]).unwrap();
        let hashes = submit_pending(&mut client, &mut journal).unwrap();
        assert_eq!(hashes, vec!["local-tx-1"]);
        assert_eq!(
            client.submitted,
            vec![OperatorCommand::Buyback { bnb_amount: 2 }]
        );
        assert!(matches!(
            journal.records.get(&ids[1]).unwrap().status,
            CommandStatus::Confirmed { .. }
        ));
    }

    #[test]
    fn encodes_direct_token_operator_calls() {
        let context = test_context();
        let transfer = encode_command_call(
            &context,
            &OperatorCommand::TransferBnb {
                to: "0x3333333333333333333333333333333333333333".into(),
                amount: 10,
                reason: "direct-referral".into(),
            },
        )
        .unwrap();
        assert_eq!(transfer.target, context.token_address);
        assert_eq!(transfer.value, 0);
        assert!(transfer
            .data
            .starts_with(&function_selector("operatorCall(address,uint256,bytes)")));

        let credit_vault =
            encode_command_call(&context, &OperatorCommand::CreditVault { amount: 20 }).unwrap();
        assert!(credit_vault
            .data
            .contains("2222222222222222222222222222222222222222"));

        let pull =
            encode_command_call(&context, &OperatorCommand::PullPairTokens { bps: 10 }).unwrap();
        assert_eq!(pull.target, context.token_address);
        assert!(pull
            .data
            .starts_with(&function_selector("pullPairTokens(uint16)")));
    }

    #[test]
    fn refuses_commands_that_need_runtime_quotes_or_multi_step_safety() {
        let context = test_context();
        assert!(matches!(
            encode_command_call(
                &context,
                &OperatorCommand::AddLiquidity {
                    bnb_amount: 1,
                    token_value_bnb: 1,
                },
            ),
            Err(CommandEncodeError::Unsupported(_))
        ));
        assert!(matches!(
            encode_command_call(
                &context,
                &OperatorCommand::BurnTokenByBnbValue {
                    amount: 1,
                    reason: "exit-burn".into(),
                },
            ),
            Err(CommandEncodeError::Unsupported(_))
        ));
    }

    #[test]
    fn encodes_router_and_vault_execution_calldata() {
        let swap = encode_swap_exact_eth_for_tokens(
            10,
            "0x4444444444444444444444444444444444444444",
            "0x1111111111111111111111111111111111111111",
            "0x000000000000000000000000000000000000dead",
            123,
        )
        .unwrap();
        assert_eq!(&hex_encode(&swap)[..8], &function_selector("swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)")[2..10]);

        let vault_execute = encode_dynamic_bytes_call(
            "execute(address,uint256,bytes)",
            "0x3333333333333333333333333333333333333333",
            1,
            &swap,
        )
        .unwrap();
        assert!(vault_execute.starts_with(&function_selector("execute(address,uint256,bytes)")));

        let burn = encode_burn_call(123).unwrap();
        assert_eq!(
            &hex_encode(&burn)[..8],
            &function_selector("burn(uint256)")[2..10]
        );
    }

    #[test]
    fn quotes_pair_amounts_with_slippage() {
        let reserves = PairReserves {
            token_reserve: 1_000_000,
            bnb_reserve: 100,
        };
        assert_eq!(quote_token_amount(1, &reserves).unwrap(), 10_000);
        assert_eq!(
            quote_synced_pull_token_amount(10, &reserves).unwrap(),
            90_910
        );
        assert_eq!(apply_slippage(10_000, 500).unwrap(), 9_500);
        assert_eq!(v2_amount_out(1, 100, 1_000_000).unwrap(), 9_876);
    }

    #[test]
    fn marks_failed_command_when_chain_submission_fails() {
        #[derive(Debug)]
        struct FailingClient;

        impl ChainClient for FailingClient {
            type Error = &'static str;

            fn submit(&mut self, _: &OperatorCommand) -> Result<String, Self::Error> {
                Err("boom")
            }
        }

        let mut journal = ExecutionJournal::default();
        let ids = journal.plan_batch("batch", vec![OperatorCommand::CreditVault { amount: 1 }]);
        let error = submit_pending(&mut FailingClient, &mut journal).unwrap_err();
        assert!(matches!(error, SubmitPendingError::Chain("boom")));
        assert!(matches!(
            journal.records[&ids[0]].status,
            crate::journal::CommandStatus::Failed { .. }
        ));
    }

    fn test_context() -> ChainExecutionContext {
        ChainExecutionContext {
            token_address: "0x1111111111111111111111111111111111111111".into(),
            vault_address: "0x2222222222222222222222222222222222222222".into(),
            router_address: "0x3333333333333333333333333333333333333333".into(),
            owner_address: "0x9999999999999999999999999999999999999999".into(),
            burn_address: "0x000000000000000000000000000000000000dead".into(),
            slippage_bps: 500,
            deadline_seconds: 600,
        }
    }
}
