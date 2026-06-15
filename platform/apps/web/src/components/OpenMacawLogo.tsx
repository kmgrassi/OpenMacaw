import { cn } from "../lib/cn";

type OpenMacawLogoProps = {
  className?: string;
  imageClassName?: string;
};

export function OpenMacawLogo({
  className,
  imageClassName,
}: OpenMacawLogoProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-700/70 bg-slate-900",
        className,
      )}
    >
      <img
        src="/openmacaw-logo.png"
        alt=""
        aria-hidden="true"
        className={cn("h-full w-full object-cover", imageClassName)}
      />
    </span>
  );
}
