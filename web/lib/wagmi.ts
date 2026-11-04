import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { BASE_RPC_URL } from "./config";

export const wagmiConfig = createConfig({
  chains: [base],
  transports: { [base.id]: http(BASE_RPC_URL, { retryCount: 4, retryDelay: 500 }) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
