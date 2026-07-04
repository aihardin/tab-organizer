# Tab Organizer

A Chrome extension that uses Claude AI to tame end-of-day tab sprawl. Type your goal for the day, and it groups your open tabs by topic, surfaces the 10 most important ones, saves a Markdown summary, bookmarks everything in a structured folder, and closes the rest — so you can stop for the day knowing nothing important is lost.

## Features

- **Goal-aware grouping** — tabs are organized by relevance to what you were actually working on
- **Top 10 shortlist** — the most important tabs for your goal, surfaced and pre-selected to keep
- **Markdown summary** — a `.md` report of your session, saved to Downloads
- **Structured bookmarks** — a dated folder tree, one subfolder per topic group
- **Review before closing** — nothing closes until you confirm; adjust the keep/close selection freely

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode** (top right)
2. Click **Load unpacked** and select this folder
3. Click the toolbar icon → **Settings**, and paste your Anthropic API key (from [console.anthropic.com](https://console.anthropic.com))

## Usage

1. Click the toolbar icon
2. Type your goal for the day
3. Click **Analyze Tabs** — a review tab opens with your groups and top 10
4. Adjust the selection, then **Download Summary**, **Bookmark All Groups**, and **Close Non-Kept Tabs**

## How it works

The extension's service worker collects your open tabs (titles + URLs), sends them to the Claude API (`claude-sonnet-4-6`) with your stated goal, and receives structured JSON describing the groups, the top 10, and a summary. Your API key is stored locally via `chrome.storage.local` and is sent only to `api.anthropic.com` — never to any other service.

## Privacy

Tab titles and URLs are sent to the Anthropic API for analysis. Your API key never leaves your device except as the authorization header on requests to Anthropic. No analytics, no third-party servers.
