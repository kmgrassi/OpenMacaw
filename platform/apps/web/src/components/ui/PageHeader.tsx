import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

type PageHeaderVariant = "route" | "section" | "dashboard";
type PageHeaderStackAt = "sm" | "md";
type PageHeaderTitleAs = "h1" | "h2" | "h3";

const titleStyles: Record<PageHeaderVariant, string> = {
  route: "text-xl font-semibold text-slate-100",
  section: "text-lg font-semibold text-slate-200",
  dashboard: "text-2xl font-semibold tracking-tight text-white",
};

const descriptionStyles: Record<PageHeaderVariant, string> = {
  route: "mt-1 text-sm text-slate-500",
  section: "mt-1 text-sm text-slate-400",
  dashboard: "mt-2 text-sm text-slate-400",
};

const layoutStyles: Record<PageHeaderStackAt, string> = {
  sm: "sm:flex-row sm:justify-between",
  md: "md:flex-row md:justify-between",
};

const actionStyles: Record<PageHeaderStackAt, string> = {
  sm: "sm:self-auto",
  md: "md:self-auto",
};

type PageHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  metadata?: ReactNode;
  variant?: PageHeaderVariant;
  bordered?: boolean;
  stackAt?: PageHeaderStackAt;
  titleId?: string;
  titleAs?: PageHeaderTitleAs;
  actionsClassName?: string;
  contentClassName?: string;
};

export function PageHeader({
  title,
  actions,
  description,
  eyebrow,
  metadata,
  variant = "section",
  bordered = false,
  stackAt = "sm",
  titleId,
  titleAs,
  className,
  actionsClassName,
  contentClassName,
  ...rest
}: PageHeaderProps) {
  const Title = titleAs ?? (variant === "section" ? "h2" : "h1");

  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        layoutStyles[stackAt],
        bordered && "border-b border-border pb-5",
        className,
      )}
      {...rest}
    >
      <div className={cn("min-w-0", contentClassName)}>
        {eyebrow && (
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500">
            {eyebrow}
          </div>
        )}
        <Title
          id={titleId}
          className={cn(titleStyles[variant], eyebrow && "mt-1")}
        >
          {title}
        </Title>
        {description && (
          <p className={descriptionStyles[variant]}>{description}</p>
        )}
        {metadata && <div className="mt-2">{metadata}</div>}
      </div>
      {actions && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 self-start",
            actionStyles[stackAt],
            actionsClassName,
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
