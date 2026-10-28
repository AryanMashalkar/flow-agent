// In-memory todo store. Storage is still undecided (SQLite was the first idea).
let nextId = 1;
const todos = [];

export function addTodo(title, now = Date.now()) {
  if (!title || !title.trim()) throw new Error('title is required');
  const todo = { id: nextId++, title: title.trim(), done: false, createdAt: now };
  todos.push(todo);
  return todo;
}

export function completeTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error(`no todo with id ${id}`);
  todo.done = true;
  return todo;
}

/** Todos in the order the list shows them: oldest first. */
export function listTodos() {
  return [...todos].sort((a, b) => a.createdAt - b.createdAt);
}

export function resetTodos() {
  todos.length = 0;
  nextId = 1;
}
