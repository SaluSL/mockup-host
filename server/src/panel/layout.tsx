const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 60rem; }
  h1 { font-size: 1.25rem; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  form.inline { display: inline; }
  input, button { font: inherit; padding: .35rem .5rem; }
  .warn { color: #a15c00; background: #f9c74f22; padding: .4rem .6rem; border-radius: .3rem; display: block; margin-top: .35rem; font-size: .85em; }
  .muted { opacity: .65; font-size: .85em; }
  .error { color: #b3261e; }
  .flash { background: #2a9d8f22; padding: .5rem .75rem; border-radius: .3rem; margin-bottom: 1rem; }
`;

export function Layout(props: { title: string; children: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{props.title}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
