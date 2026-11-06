import { OG_ALT, OG_SIZE, renderCard } from "@/lib/og-card";

// Rendered once per deploy from the live status: image rendering is too heavy to run on every crawler request.
export const dynamic = "force-static";
export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderCard();
}
