import { readFile } from "node:fs/promises";
import path from "node:path";

export type DeploymentPreset = {
  label: string;
  chainId: string;
  managerAddress: string;
  tokenAddress: string;
  rewardEngineAddress: string;
};

async function readDeployment(fileName: string, label: string): Promise<DeploymentPreset | null> {
  try {
    const filePath = path.join(process.cwd(), "deployments", fileName);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      chainId?: number;
      manager?: string;
      token?: string;
      rewardEngine?: string;
    };

    if (!parsed.chainId || !parsed.manager || !parsed.token || !parsed.rewardEngine) {
      return null;
    }

    return {
      label,
      chainId: String(parsed.chainId),
      managerAddress: parsed.manager,
      tokenAddress: parsed.token,
      rewardEngineAddress: parsed.rewardEngine,
    };
  } catch {
    return null;
  }
}

export async function getDeploymentPresets() {
  const presets = await Promise.all([
    readDeployment("bsc.json", "主网部署记录"),
    readDeployment("bscTestnet.json", "测试网部署记录"),
  ]);

  return presets.filter((preset): preset is DeploymentPreset => preset !== null);
}