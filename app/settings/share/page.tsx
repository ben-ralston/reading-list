// /settings/share — iOS Share Sheet setup (#191).
//
// Documents the "Save to Reading List" iOS Shortcut: build it from the Cherri
// source in shortcuts/ (or by hand), paste your SHARE_API_SECRET into it once,
// and add it to the Share Sheet. The Shortcut POSTs the shared URL to
// /api/add-entry (dual cookie/bearer auth) so anything you're reading can be
// saved in one tap. app/settings/layout.tsx renders the back link, "Settings"
// heading, and nav strip; this page owns only its sub-heading + content.

// Placeholder: replace with your own deployment's URL (also set in
// shortcuts/save-to-reading-list.cherri).
const ENDPOINT = 'https://your-app.example.com/api/add-entry'
const SHORTCUT_SOURCE = 'shortcuts/save-to-reading-list.cherri'

export default function SharePage() {
  return (
    <>
      <h2 className="mt-6 text-xl font-semibold">Save to Reading List (iOS Share Sheet)</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Add a <strong>Save to Reading List</strong> action to your iPhone Share Sheet, so any
        article, video, or post can be saved in one tap from Safari, Reeder, YouTube, or any other
        app — no need to open this app first. It runs the same add pipeline as the{' '}
        <strong>+</strong> button (metadata fetch, enrichment, dedup).
      </p>

      <h3 className="mt-6 text-base font-semibold">Set it up</h3>
      <ol className="mt-2 text-sm text-muted-foreground space-y-2 list-decimal list-inside">
        <li>
          Compile{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{SHORTCUT_SOURCE}</code> from this
          repository with Cherri (set its endpoint to your deployment first), then open the
          resulting file in the Shortcuts app on your iPhone. (If iOS blocks it, enable{' '}
          <strong>Settings → Shortcuts → Allow Untrusted Shortcuts</strong> and try again.)
        </li>
        <li>
          Edit the shortcut&rsquo;s <strong>Get Contents of URL</strong> action and replace{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">REPLACE_WITH_SHARE_API_SECRET</code>{' '}
          in the <strong>Authorization</strong> header with your <code className="rounded bg-muted px-1 py-0.5 text-xs">SHARE_API_SECRET</code>{' '}
          value. You only do this once.
        </li>
        <li>
          In the shortcut&rsquo;s settings, make sure <strong>Show in Share Sheet</strong> is on and
          it accepts <strong>URLs</strong> (and Text).
        </li>
        <li>
          Done. Open any page → <strong>Share</strong> → <strong>Save to Reading List</strong>. A
          notification confirms the saved title.
        </li>
      </ol>

      <h3 className="mt-6 text-base font-semibold">Prefer to build it by hand?</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A three-action shortcut does the whole thing:
      </p>
      <ol className="mt-2 text-sm text-muted-foreground space-y-2 list-decimal list-inside">
        <li>
          <strong>Get URLs from Shortcut Input</strong> (accepts URLs / Text from the Share Sheet).
        </li>
        <li>
          <strong>Get Contents of URL</strong> — set to <strong>POST</strong> to{' '}
          <code className="block mt-1 rounded bg-muted px-2 py-1 text-xs break-all">{ENDPOINT}</code>
          with headers <code className="rounded bg-muted px-1 py-0.5 text-xs">Authorization: Bearer &lt;your SHARE_API_SECRET&gt;</code>{' '}
          and <code className="rounded bg-muted px-1 py-0.5 text-xs">Content-Type: application/json</code>, and a{' '}
          <strong>JSON</strong> request body of{' '}
          <code className="block mt-1 rounded bg-muted px-2 py-1 text-xs break-all">
            {'{ "input": <Shortcut Input URL>, "saveRawOnFailure": true }'}
          </code>
        </li>
        <li>
          <strong>Show Notification</strong> with the <code className="rounded bg-muted px-1 py-0.5 text-xs">title</code>{' '}
          from the response (e.g. &ldquo;Saved: &lt;title&gt;&rdquo;).
        </li>
      </ol>
      <p className="mt-3 text-sm text-muted-foreground">
        <code className="rounded bg-muted px-1 py-0.5 text-xs">saveRawOnFailure</code> means a link
        that can&rsquo;t be read is still saved (as its raw URL) for you to clean up later, rather
        than failing silently.
      </p>
    </>
  )
}
