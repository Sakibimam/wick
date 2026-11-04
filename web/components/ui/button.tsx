import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex h-11 items-center justify-center gap-2 rounded-control px-4 text-[15px] font-medium transition-[background-color,border-color,color,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:active:translate-y-0 aria-disabled:pointer-events-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent-hover disabled:bg-sunken disabled:text-muted aria-disabled:bg-sunken aria-disabled:text-muted",
        secondary: "border border-rule-2 bg-panel text-ink hover:border-ink-2 disabled:text-muted",
        ghost: "text-ink-2 hover:bg-sunken hover:text-ink disabled:text-muted",
        inverse: "border border-graphite-rule text-on-graphite hover:border-on-graphite-muted",
      },
      size: { default: "h-11", sm: "h-9 px-3 text-[13px]", chip: "h-8 rounded-control border border-rule-2 bg-panel px-3 text-[13px] text-ink-2 hover:border-ink-2 hover:text-ink" },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {asChild ? children : <>{loading ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}{children}</>}
    </Comp>
  );
});
Button.displayName = "Button";
