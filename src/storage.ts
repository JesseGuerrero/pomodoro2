import { supabase } from "./supabase";

export type Todo = {
  id: string;
  text: string;
  completed: boolean;
  priority: boolean;
  created_at: string;
};

export type Session = {
  id: string;
  started_at: string;
  duration_minutes: number;
  completed: boolean;
  created_at?: string;
};

// --- Todos ---

export async function getTodos(): Promise<Todo[]> {
  const { data } = await supabase.from("todos").select("*").order("created_at", { ascending: false });
  return (data as Todo[]) || [];
}

export async function addTodo(todo: Todo): Promise<void> {
  await supabase.from("todos").insert(todo);
}

export async function updateTodo(id: string, fields: Partial<Todo>): Promise<void> {
  await supabase.from("todos").update(fields).eq("id", id);
}

export async function deleteTodo(id: string): Promise<void> {
  await supabase.from("todos").delete().eq("id", id);
}

// --- Sessions ---

export async function getSessions(): Promise<Session[]> {
  const { data } = await supabase.from("sessions").select("*").order("started_at", { ascending: false });
  return (data as Session[]) || [];
}

export async function addSession(session: Omit<Session, "created_at">): Promise<void> {
  await supabase.from("sessions").insert(session);
}
