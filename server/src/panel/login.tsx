/** @jsxImportSource hono/jsx */
import { Layout } from "./layout.js";

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="Sign in">
      <h1>Mockups</h1>
      {props.error ? <p class="error">{props.error}</p> : null}
      <form method="post" action="/login">
        <p>
          <label>
            Username
            <br />
            <input name="username" autocomplete="username" required />
          </label>
        </p>
        <p>
          <label>
            Password
            <br />
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
        </p>
        <button type="submit">Sign in</button>
      </form>
    </Layout>
  );
}
