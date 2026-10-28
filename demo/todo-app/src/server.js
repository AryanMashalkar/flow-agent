import { createServer } from 'node:http';
import { addTodo, completeTodo, listTodos } from './todos.js';
import { login } from './auth.js';

const PORT = Number(process.env.PORT) || 8080;

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/todos') return send(res, 200, listTodos());
    if (req.method === 'POST' && url.pathname === '/todos') return send(res, 201, addTodo((await body(req)).title));
    const done = url.pathname.match(/^\/todos\/(\d+)\/done$/);
    if (req.method === 'POST' && done) return send(res, 200, completeTodo(Number(done[1])));
    if (req.method === 'POST' && url.pathname === '/login') {
      const { username, password } = await body(req);
      return send(res, login(username, password) ? 200 : 401, {});
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`todo-app on http://localhost:${PORT}`));
