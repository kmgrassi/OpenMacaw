type WizardCheckProps = {
  label: string;
  state: "pass" | "fail" | "pending";
  detail: string;
};

export function WizardCheck({ label, state, detail }: WizardCheckProps) {
  const tone =
    state === "pass"
      ? "border-green-600/30 bg-green-950/20 text-green-200"
      : state === "fail"
        ? "border-amber-600/30 bg-amber-950/20 text-amber-200"
        : "border-white/5 bg-surface-raised text-slate-300";
  const marker =
    state === "pass" ? "OK" : state === "fail" ? "Needs attention" : "Pending";

  return (
    <div className={`rounded-md border px-3 py-2 ${tone}`}>
      <div className="font-medium">{label}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide opacity-75">
        {marker}
      </div>
      <div className="mt-1 text-slate-400">{detail}</div>
    </div>
  );
}
