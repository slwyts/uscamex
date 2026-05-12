// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.6.0
pragma solidity ^0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721Pausable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Pausable.sol";

contract GNFT is ERC721, ERC721Enumerable, ERC721Pausable, Ownable {
    uint256 private _nextTokenId;
    string private _tokenURI;

    event TokenURIUpdated(string newURI);

    constructor(address initialOwner)
        ERC721(unicode"美加墨", "USCAMEX")
        Ownable(initialOwner)
    {
        _tokenURI = "https://res.uscamex.info/metadata.json";
    }

    function tokenURI(uint256 tokenId) public view override(ERC721) returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURI;
    }

    function setTokenURI(string calldata newURI) external onlyOwner {
        _tokenURI = newURI;
        emit TokenURIUpdated(newURI);
    }

    function pause() public onlyOwner {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    function safeMint(address to) public onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        return tokenId;
    }

    receive() external payable {
        require(!paused(), "GNFT: minting is paused");
        require(msg.value == 1 ether, "GNFT: must send exactly 1 BNB");
        require(balanceOf(msg.sender) == 0, "GNFT: already holds an NFT");
        uint256 tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);
        (bool ok, ) = owner().call{value: msg.value}("");
        require(ok, "GNFT: BNB transfer to owner failed");
    }

    // The following functions are overrides required by Solidity.

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable, ERC721Pausable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
