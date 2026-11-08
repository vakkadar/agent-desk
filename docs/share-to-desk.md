# Share to Desk (iPhone, Android, desktop)

Sharing text or a link to the desk prefills the composer on the General tab. It never sends: review, then press Send.

## iPhone: Shortcut

iOS has no Web Share Target, so use a Shortcut that opens a prefill link.

1. Shortcuts app, new shortcut, name it "Send to Desk". Tap the (i) button and turn on "Show in Share Sheet"; set "Share Sheet Types" to Text and URLs (and Safari web pages).
2. Add action "Receive input from Share Sheet" (this is added automatically).
3. Add "URL Encode" (Encode) on Shortcut Input.
4. Add "Text" with: `https://agent-desk.sanatanadharma.cloud/#q=` followed by the URL Encode result. Optional: append `&source=<source id>` to prefill a project instead of General.
5. Add "Open URLs" on that text.

Use from any app: Share, then "Send to Desk".

What works: the link opens in the default browser (Safari). Safari and the home-screen app keep separate storage, so in Safari you may need to sign in with the desk token once (tap the status line). iOS usually does not hand the link to the home-screen app; the Safari tab is fine for this. The prefill reads `#q` once, then removes it from the URL (a `#token=` in the hash is left alone).

## Android / desktop Chrome

With the desk installed as an app, it appears in the Share menu (`share_target` in `manifest.webmanifest`). Shared title, text and URL arrive as `?title=&text=&url=` and prefill the composer the same way.

## Attachments

The composer has a paperclip button (camera, photos or files on iPhone), plus paste and drag-and-drop on desktop. Files go to `<thread folder>/.desk-uploads/<date>/` (General: the general dir; projects: the source folder, and `.desk-uploads/` is added to `.gitignore` when it is a git repo). Limits: 5 files, 20 MB each. The prompt gets the absolute paths appended so Claude reads them with its Read tool.
