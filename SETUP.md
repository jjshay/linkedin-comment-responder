# LinkedIn Comment Auto-Responder Setup Guide

## Overview

This system automatically:
1. Monitors your LinkedIn posts via RSS.app
2. Scrapes new comments using PhantomBuster
3. Fetches commenter profile data
4. Generates 3 response drafts with GPT-4
5. Has Claude analyze and pick the best one
6. Verifies with Gemini for authenticity
7. Posts approved replies via LinkedIn API

---

## Step 1: Create Google Sheet

1. Go to https://sheets.google.com
2. Create a new spreadsheet
3. Name it "LinkedIn Comment Responder"
4. Go to **Extensions → Apps Script**
5. Delete the default code and paste the contents of `Code.gs`
6. Save the project (Ctrl+S)

---

## Step 2: Configure Script Properties

In Apps Script editor:
1. Click the gear icon ⚙️ (Project Settings)
2. Scroll to **Script Properties**
3. Add each of these properties:

| Property | Value |
|----------|-------|
| `PHANTOMBUSTER_API_KEY` | Your PhantomBuster API key |
| `PHANTOMBUSTER_COMMENTER_AGENT_ID` | Agent ID for LinkedIn Post Commenters Export |
| `PHANTOMBUSTER_PROFILE_AGENT_ID` | Agent ID for LinkedIn Profile Scraper |
| `LINKEDIN_ACCESS_TOKEN` | Your LinkedIn OAuth access token |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `GOOGLE_AI_KEY` | Your Google AI Studio key |
| `RSS_FEED_URL` | Your RSS.app feed URL |

---

## Step 3: PhantomBuster Setup

### A. LinkedIn Post Commenters Export

1. Go to https://phantombuster.com
2. Create a new "LinkedIn Post Commenters Export" Phantom
3. Configure it:
   - **Input**: Google Sheet URL or CSV with your post URLs
   - **Session cookie**: Connect your LinkedIn session
   - **Extract comment replies**: Enable this for thread replies
4. Note the **Agent ID** from the URL (e.g., `/phantoms/12345678`)
5. Run it manually once to verify it works

### B. LinkedIn Profile Scraper

1. Create a new "LinkedIn Profile Scraper" Phantom
2. Configure it:
   - **Input**: Google Sheet or CSV with profile URLs
   - **Session cookie**: Connect your LinkedIn session
3. Note the **Agent ID**
4. Run it manually once to verify

### Getting Your PhantomBuster API Key

1. Go to https://phantombuster.com/workspace/settings
2. Copy your API key

---

## Step 4: RSS.app Setup

1. Go to https://rss.app
2. Create a feed for your LinkedIn profile/posts
3. Copy the RSS feed URL
4. Add it to Script Properties as `RSS_FEED_URL`

---

## Step 5: LinkedIn API Access

You need an approved LinkedIn app with these permissions:
- `w_member_social` - to post comments
- `r_basicprofile` - to get your member URN

### Getting Your Access Token

Option A: Using LinkedIn Developer Portal
1. Go to https://www.linkedin.com/developers/apps
2. Create or select your app
3. Go to Auth tab → Generate a new access token

Option B: Using OAuth flow (more secure, longer-lived tokens)
- Implement OAuth 2.0 flow for production use
- Token refresh will need to be added to the script

---

## Step 6: Initialize the System

1. Return to your Google Sheet
2. Refresh the page
3. You should see a new menu: **LinkedIn Responder**
4. Click **LinkedIn Responder → Setup Sheets**
5. Click **LinkedIn Responder → Setup Triggers**
6. Click **LinkedIn Responder → Test API Connections** (in script editor: Run → testAPIConnections)

---

## Step 7: Manual Workflow (Testing)

Run each step manually first to verify:

1. **LinkedIn Responder → Fetch RSS Posts**
   - Should add your post URLs to the Posts sheet

2. **LinkedIn Responder → Trigger Comment Scrape**
   - Launches PhantomBuster to scrape comments
   - Wait 5-10 minutes for PhantomBuster to complete

3. **LinkedIn Responder → Process Phantom Results**
   - Pulls comment data into the Comments sheet

4. **LinkedIn Responder → Scrape Profiles**
   - Launches profile scraper for commenters
   - Wait 5-10 minutes

5. **LinkedIn Responder → Process Profiles**
   - Adds profile data to Comments sheet

6. **LinkedIn Responder → Generate Responses**
   - Calls GPT-4, Claude, and Gemini
   - Adds response drafts to Responses sheet

7. **Review Responses Sheet**
   - Check the generated responses
   - Set Status column to "APPROVED" for ones you want to post

8. **LinkedIn Responder → Post Approved Responses**
   - Posts approved replies to LinkedIn

---

## Automated Schedule

After running `Setup Triggers`, the system runs automatically:
- **Every 6 hours**: Fetches new posts from RSS and triggers comment scraping
- **Every 2 hours**: Processes results and generates responses

---

## Sheet Structure

### Posts Sheet
| Column | Description |
|--------|-------------|
| PostURL | LinkedIn post URL |
| PostURN | Extracted URN |
| PostText | Post preview text |
| DateAdded | When discovered |
| LastChecked | Last comment check |

### Comments Sheet
| Column | Description |
|--------|-------------|
| CommentID | Unique identifier |
| PostURL | Parent post |
| CommentText | The comment |
| CommenterName | Who commented |
| CommenterURL | Profile link |
| CommenterHeadline | Job title |
| CommenterCompany | Company |
| ProfileData | Full JSON profile |
| Status | NEW → PROFILE_READY → RESPONSES_GENERATED |
| DateFound | When discovered |
| CommentURN | For replying |
| ParentCommentURN | If nested reply |

### Responses Sheet
| Column | Description |
|--------|-------------|
| CommentID | Links to Comments |
| Draft1_GPT | First option |
| Draft2_GPT | Second option |
| Draft3_GPT | Third option |
| ClaudeAnalysis | Selection reasoning |
| GeminiVerification | Quality check |
| SelectedDraft | Which was chosen |
| FinalResponse | What gets posted |
| Status | READY_FOR_REVIEW → APPROVED → POSTED |
| PostedAt | Timestamp |
| LinkedInResponseURN | Confirmation |

---

## Troubleshooting

### "No comment URN found"
- PhantomBuster may not be returning the comment ID
- Check the raw output in PhantomBuster dashboard
- You may need to construct URNs manually

### LinkedIn API 401 errors
- Access token expired (they last 60 days)
- Re-generate token and update Script Properties

### PhantomBuster rate limits
- Free tier: limited execution time
- Reduce frequency if hitting limits

### Responses not generating
- Check Log sheet for errors
- Test API connections individually
- Verify API keys are correct

---

## Customization

### Change Response Style
Edit the `systemPrompt` in `generateResponses()` function:
```javascript
const systemPrompt = `You are helping craft thoughtful, professional LinkedIn comment replies...`;
```

### Adjust Trigger Frequency
Modify `setupTriggers()`:
```javascript
ScriptApp.newTrigger('runFullWorkflow')
  .timeBased()
  .everyHours(12) // Change from 6 to 12
  .create();
```

### Skip Human Approval
Auto-approve responses by changing status:
```javascript
responsesSheet.appendRow([
  // ... other fields ...
  'APPROVED', // Instead of 'READY_FOR_REVIEW'
  // ...
]);
```
