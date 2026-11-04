import type { Metadata } from "next";
import { LedgerPage } from "@/components/ledger-page";

export const metadata: Metadata = { title: "Brain ledger: Upkeep" };

export default function Page() {
  return <LedgerPage />;
}
