import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function load(name: string) {
  return JSON.parse(readFileSync(`${root}/contracts/out/${name}.sol/${name}.json`, "utf8")).abi;
}

export const grantStoreAbi = load("GrantStore");
export const registryAbi = load("AttenuatedSubregistry");
export const executorAbi = load("Executor");
export const capabilityRegistryAbi = load("CapabilityRegistry");
