import { Card } from "../ui/Card";

type Props = {
  onChooseCloud: () => void;
  onChooseLocal: () => void;
};

export function ChoosePathCard({ onChooseCloud, onChooseLocal }: Props) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <button
        type="button"
        onClick={onChooseCloud}
        className="text-left"
        aria-label="Use a cloud model"
      >
        <Card className="h-full border-slate-700 bg-slate-900/70 p-5 transition-colors hover:border-blue-500">
          <div className="text-lg font-semibold text-white">
            Use a cloud model
          </div>
          <p className="mt-2 text-sm text-slate-300">
            Bring an OpenAI or Anthropic API key.
          </p>
          <p className="mt-4 text-sm text-slate-500">
            Fastest path. Costs go to your provider account.
          </p>
          <span className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white">
            Continue
          </span>
        </Card>
      </button>

      <button
        type="button"
        onClick={onChooseLocal}
        className="text-left"
        aria-label="Use a local model"
      >
        <Card className="h-full border-slate-700 bg-slate-900/70 p-5 transition-colors hover:border-blue-500">
          <div className="text-lg font-semibold text-white">
            Use a local model
          </div>
          <p className="mt-2 text-sm text-slate-300">
            Run a model on this machine, no API key required.
          </p>
          <p className="mt-4 text-sm text-slate-500">
            Requires installing the local runtime relay.
          </p>
          <span className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white">
            Continue
          </span>
        </Card>
      </button>
    </div>
  );
}
