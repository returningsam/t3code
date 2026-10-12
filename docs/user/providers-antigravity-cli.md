# Antigravity CLI

T3 Code can run the Antigravity CLI (`agy`) you already installed and signed in to. It uses
agy's own login, models, settings, and conversation history, so T3 Code has no sign-in step
for this provider. To have T3 Code install Google's Antigravity agent and sign in for you,
use [Antigravity](./providers-antigravity.md) instead.

## Set up the Antigravity CLI

1. Install the [Antigravity CLI](https://antigravity.google) on the machine that runs the
   T3 Code server. Run `agy` in a terminal there and sign in.
2. Open **Settings → Providers**, choose that environment, and enable **Antigravity CLI**.

T3 Code supports agy 1.3.3 or newer. Set **Binary path** if agy is not on the server's `PATH`.
If the provider reports that agy is not signed in, run `agy` in a terminal on that machine to
sign in, then refresh the provider.

## Models and threads

T3 Code shows the models agy lists. **agy default** runs the model selected in agy itself. A
model that agy lists at several effort levels appears once, with an effort picker.

Each thread is one agy conversation. T3 Code resumes it after a server restart, a model
change, or **Stop**. Attachments reach agy as saved file paths that the agent opens with its
tools. Plan mode and rewinding a conversation are unavailable, agents on this provider cannot
use T3 Code's MCP tools, and this provider does not write commit messages, pull request text,
or thread titles.

## Permissions

agy cannot ask for approval when T3 Code runs it, so the provider offers two
[permission modes](./permission-modes.md):

- **Full access** lets agy run every action without its permission checks.
- **Supervised** runs agy under its own permission rules. agy blocks any action those rules
  do not allow, and the thread lists what it blocked. Switch the thread to **Full access**,
  or add allow rules to agy's settings, to let those actions run.

A thread set to **Auto-accept edits** or **Auto** runs in **Supervised**.
