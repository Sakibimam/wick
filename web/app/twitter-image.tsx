import { OG_ALT, OG_SIZE, renderCard } from "@/lib/og-card";

export const dynamic = "force-dynamic";
export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderCard();
}
