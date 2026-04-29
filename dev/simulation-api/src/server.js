import { createServer } from "./app.js";

const port = Number(process.env.PORT || 4500);
const { server } = createServer();

server.listen(port, () => {
  console.log(`simulation-api listening on http://127.0.0.1:${port}`);
});
