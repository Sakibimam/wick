import type { Metadata } from "next";
import { LedgerPage } from "@/components/ledger-page";

export const metadata: Metadata = { title: "Wick: every transaction in the loop, unrolled" };

export default function Page() {
  return <LedgerPage />;
}
