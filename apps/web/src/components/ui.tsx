import type { ReactNode } from "react";
import { ApiError } from "../api";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return <div className="alert error">{msg}</div>;
}

export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

/** Laadskelet: grijze vormen op de plek van de inhoud, zodat de pagina niet leeg oogt tijdens het laden. */
export const Loading = ({ rows = 4 }: { rows?: number }) => (
  <div className="skeleton" role="status" aria-label="Laden">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="skeleton-row">
        <span className="sk sk-dot" />
        <span className="sk" style={{ width: `${[72, 58, 66, 50, 62][i % 5]}%` }} />
        <span className="sk sk-end" />
      </div>
    ))}
  </div>
);

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <span className="badge green">Actief</span> : <span className="badge">Inactief</span>;
}

export function StatusPill({ status }: { status: { name: string; color: string } }) {
  return <span className={`status ${status.color}`}>{status.name}</span>;
}
