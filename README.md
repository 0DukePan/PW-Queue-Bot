# PQB

Discord bot for managing a practical-work queue, including student sign-ups,
priority corrections, staff controls, and a welcome message.

## Requirements

- Node.js 20.6 or newer
- A Discord application and bot

## Setup

1. Install dependencies:

   ```sh
   npm ci
   ```

2. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN`: the bot token from the Discord Developer Portal
   - `DISCORD_CLIENT_ID`: the application's ID

   On Windows PowerShell, use `Copy-Item .env.example .env`.

3. In the Discord Developer Portal, enable the **Server Members Intent** for
   the bot. Invite it to your server with the `bot` and `applications.commands`
   scopes and permissions to view channels, send messages, and embed links.
   The bot's staff controls check for roles named `Prof` or `Délégué`.

4. Start the bot:

   ```sh
   npm start
   ```

Use `/tp-start` in the desired channel to post the queue. Only members with one
of the configured staff roles can start the queue or advance students.

## Security

Keep `.env` private; never commit bot tokens. If a token has been exposed,
revoke it in the Discord Developer Portal and replace it before running the bot.
