import { createConfig, http } from "wagmi";
import { coinbaseWallet, injected, mock } from "wagmi/connectors";
import { base } from "wagmi/chains";
import { BASE_RPC_URL, DEV_ACCOUNT, LOCAL_FORK } from "./config";

// On a local fork the chain's own RPC is the fork, so every read and every wallet request stays on this machine.
const chain = LOCAL_FORK ? { ...base, rpcUrls: { default: { http: [BASE_RPC_URL] } } } : base;

// A browser wallet on chain 8453 would broadcast to Base mainnet, so on a fork the only wallet is the fork's unlocked test account.
// EIP-6963 discovery adds every installed extension by name and icon; Coinbase Wallet also covers phones and smart wallets.
// WalletConnect is left out: it needs a project id and none is configured.
const connectors = LOCAL_FORK
  ? (DEV_ACCOUNT ? [mock({ accounts: [DEV_ACCOUNT], features: { reconnect: true } })] : [])
  : [injected(), coinbaseWallet({ appName: "Wick", appLogoUrl: "https://wick.earn-shield-alerts.workers.dev/icon.svg", preference: { options: "all" } })];

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors,
  multiInjectedProviderDiscovery: !LOCAL_FORK,
  transports: { [base.id]: http(BASE_RPC_URL, { retryCount: 4, retryDelay: 500 }) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
