import { Fragment, ReactNode } from "react";

interface JsonViewerProps {
  value: unknown;
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function renderPrimitive(value: unknown): ReactNode {
  if (value === null) {
    return <span className="text-slate-500">null</span>;
  }

  if (typeof value === "string") {
    return <span className="text-emerald-300">&quot;{value}&quot;</span>;
  }

  if (typeof value === "number") {
    return <span className="text-amber-300">{value}</span>;
  }

  if (typeof value === "boolean") {
    return <span className="text-cyan-300">{String(value)}</span>;
  }

  if (typeof value === "undefined") {
    return <span className="text-slate-500">undefined</span>;
  }

  return <span className="text-slate-300">{String(value)}</span>;
}

function renderJson(value: unknown, depth = 0): ReactNode {
  if (value === null || typeof value !== "object") {
    return renderPrimitive(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    return (
      <>
        [
        {"\n"}
        {value.map((item, index) => (
          <Fragment key={`array-${depth}-${index}`}>
            {indent(depth + 1)}
            {renderJson(item, depth + 1)}
            {index < value.length - 1 ? "," : ""}
            {"\n"}
          </Fragment>
        ))}
        {indent(depth)}]
      </>
    );
  }

  const entries = Object.entries(value);

  if (entries.length === 0) {
    return "{}";
  }

  return (
    <>
      {"{"}
      {"\n"}
      {entries.map(([key, item], index) => (
        <Fragment key={`obj-${depth}-${key}`}>
          {indent(depth + 1)}
          <span className="text-sky-300">&quot;{key}&quot;</span>
          <span className="text-slate-500">: </span>
          {renderJson(item, depth + 1)}
          {index < entries.length - 1 ? "," : ""}
          {"\n"}
        </Fragment>
      ))}
      {indent(depth)}
      {"}"}
    </>
  );
}

export function JsonViewer({ value }: JsonViewerProps) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/70 p-4 font-mono text-xs leading-6 text-slate-200">
      {renderJson(value)}
    </pre>
  );
}