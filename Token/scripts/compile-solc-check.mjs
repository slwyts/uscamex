import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const sources = {};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(filePath);
    return filePath.endsWith(".sol") ? [filePath] : [];
  });
}

function actualPath(sourceKey) {
  if (sourceKey.startsWith("@openzeppelin/contracts/")) {
    return path.join("node_modules", ...sourceKey.split("/"));
  }
  return sourceKey;
}

function resolveKey(importPath, fromKey) {
  if (importPath.startsWith("@openzeppelin/contracts/")) return importPath;
  if (importPath.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), importPath));
  return importPath;
}

function addSource(sourceKey) {
  sourceKey = path.posix.normalize(sourceKey);
  if (sources[sourceKey]) return;
  const content = fs.readFileSync(actualPath(sourceKey), "utf8");
  sources[sourceKey] = { content };
  for (const match of content.matchAll(/import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["'];/g)) {
    addSource(resolveKey(match[1], sourceKey));
  }
}

for (const file of [...walk("Token/src"), ...walk("Token/test")]) addSource(file);

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const messages = output.errors ?? [];
const relevantMessages = messages.filter(
  (message) =>
    message.severity === "error" ||
    !/Token\/test\//.test(message.sourceLocation?.file ?? message.formattedMessage),
);
for (const message of relevantMessages) console.log(`${message.severity}: ${message.formattedMessage}`);
if (messages.some((message) => message.severity === "error")) process.exit(1);
console.log(`Solidity compile OK (${Object.keys(sources).length} sources)`);