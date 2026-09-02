import { Layout } from "./layout.js";

export interface TokenRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function TokensPage(props: { tokens: TokenRow[]; created?: string }) {
  return (
    <Layout title="API tokens">
      <header>
        <h1>API tokens</h1>
        <a href="/">Mockups</a>
      </header>

      {props.created ? (
        <p class="flash">
          Copy this now - it is not shown again:
          <br />
          <code>{props.created}</code>
        </p>
      ) : null}

      <form method="post" action="/tokens">
        <input name="name" placeholder="Token name (e.g. laptop)" required />
        <button type="submit">Create token</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.tokens.map((token) => (
            <tr key={token.id}>
              <td>{token.name}</td>
              <td>{token.createdAt.slice(0, 10)}</td>
              <td>{token.lastUsedAt?.slice(0, 10) ?? "never"}</td>
              <td>{token.revokedAt ? "revoked" : "active"}</td>
              <td>
                {token.revokedAt ? null : (
                  <form class="inline" method="post" action={`/tokens/${token.id}/revoke`}>
                    <button type="submit">Revoke</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
}
