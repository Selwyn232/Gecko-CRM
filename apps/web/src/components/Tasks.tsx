import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { formatDate, todayIso } from "../format";
import { ErrorBox } from "./ui";

interface Task { id: string; title: string; dueDate: string | null; doneAt: string | null; assigneeName: string | null; projectNumber: string | null }

/** Taken bij een klant: toevoegen, toewijzen en afvinken. */
export function CustomerTasks({ customerId, projects }: { customerId: string; projects: { id: string; displayNumber: string }[] }) {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["tasks", customerId], queryFn: () => api.get<Task[]>(`/tasks?customerId=${customerId}`) });
  const people = useQuery({ queryKey: ["assignees"], queryFn: () => api.get<{ id: string; name: string }[]>("/tasks/assignees"), enabled: can("customers.manage") });
  const [form, setForm] = useState({ title: "", assigneeUserId: "", dueDate: "", projectId: "" });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["tasks", customerId] }), qc.invalidateQueries({ queryKey: ["work"] })]);
  const add = useMutation({
    meta: { toast: "Taak toegevoegd" },
    mutationFn: () => api.post("/tasks", { title: form.title, customerId, projectId: form.projectId || null, assigneeUserId: form.assigneeUserId || me?.id, dueDate: form.dueDate || null }),
    onSuccess: async () => {
      setForm({ ...form, title: "", dueDate: "" });
      await refresh();
    },
  });
  const done = useMutation({ mutationFn: (t: Task) => api.patch(`/tasks/${t.id}`, { done: !t.doneAt }), onSuccess: refresh });
  const tasks = list.data ?? [];
  const today = todayIso();
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Taken</h2></div>
      <ErrorBox error={add.error ?? done.error} />
      {tasks.length > 0 && (
        <ul className="task-list">
          {tasks.map((t) => (
            <li key={t.id} className={t.doneAt ? "done" : ""}>
              <label className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                <input type="checkbox" checked={!!t.doneAt} disabled={!can("customers.manage")} onChange={() => done.mutate(t)} />
                <span>
                  {t.title}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t.assigneeName ?? "—"}
                    {t.dueDate && <> · <span style={{ color: !t.doneAt && t.dueDate < today ? "var(--danger)" : undefined }}>deadline {formatDate(t.dueDate)}</span></>}
                    {t.projectNumber && <> · {t.projectNumber}</>}
                  </div>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {can("customers.manage") && (
        <form className="row task-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (form.title.trim().length >= 2) add.mutate(); }}>
          <input placeholder="Nieuwe taak, bv. klant terugbellen" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ flex: 2, minWidth: 180 }} />
          <select value={form.assigneeUserId} onChange={(e) => setForm({ ...form, assigneeUserId: e.target.value })} aria-label="Voor">
            <option value="">Voor mij</option>
            {people.data?.filter((p) => p.id !== me?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} aria-label="Deadline" />
          {projects.length > 0 && (
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} aria-label="Project">
              <option value="">Geen project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.displayNumber}</option>)}
            </select>
          )}
          <button className="btn small primary" disabled={form.title.trim().length < 2 || add.isPending}>Toevoegen</button>
        </form>
      )}
    </div>
  );
}
