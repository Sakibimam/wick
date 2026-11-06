import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WickMark } from "@/components/token-mark";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-[1312px] flex-col justify-center px-4 py-20 sm:px-6 lg:px-12">
      <WickMark className="size-16 opacity-60" />
      <h1 className="mt-6 max-w-[16ch] text-[44px] sm:text-[60px]">No wick burns at this address</h1>
      <p className="mt-4 max-w-[52ch] text-[17px] text-ink-2">This page does not exist. The machine and its ledger do, read live from Base and the 0G chain.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild><Link href="/">See the machine</Link></Button>
        <Button asChild variant="secondary"><Link href="/ledger">Read the ledger</Link></Button>
      </div>
    </div>
  );
}
