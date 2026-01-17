/**
 * ══════════════════════════════════════════════════════════════════════════════
 *                    LINKEDIN COMMENT RESPONDER - MERGE MODULE
 *                    Add this to your existing JJ Shay News Engine
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * This module responds to comments on YOUR OWN LinkedIn posts (engagement)
 * Your existing C. COMMENTS section is for outreach (commenting on others' posts)
 *
 * SETUP:
 * 1. Copy this entire file into your existing Apps Script (after your code)
 * 2. Add menu items by updating your onOpen() - see MENU INTEGRATION below
 * 3. Add Script Properties for RSS_FEED_URL and PHANTOMBUSTER_COMMENTER_AGENT_ID
 */

// ══════════════════════════════════════════════════════════════════════════════
// LINKEDIN RESPONDER CONFIG (uses your existing CONFIG.keys)
// ══════════════════════════════════════════════════════════════════════════════

const LR_CONFIG = {
  rssFeedUrl: PropertiesService.getScriptProperties().getProperty('RSS_FEED_URL') || 'https://rss.app/feeds/bJZbxhVRx0Xx77J3.xml',
  phantomCommenterAgentId: PropertiesService.getScriptProperties().getProperty('PHANTOMBUSTER_COMMENTER_AGENT_ID'),
  sheets: {
    myPosts: 'MY POSTS',
    myComments: 'MY POST COMMENTS',
    myResponses: 'MY RESPONSES',
    lrLog: 'LR LOG'
  }
};

// Field mappings for PhantomBuster output
const LR_FIELD_MAPS = {
  profileUrl: ['profileUrl', 'linkedinUrl', 'profile', 'url', 'linkedin'],
  commentText: ['commentText', 'comment', 'text', 'message', 'content'],
  commenterName: ['fullName', 'name', 'commenterName', 'firstName', 'displayName'],
  postUrl: ['postUrl', 'sourceUrl', 'originalPost', 'post', 'articleUrl'],
  headline: ['headline', 'job', 'jobTitle', 'title', 'occupation'],
  commentId: ['commentId', 'id', 'urn', 'commentUrn']
};

// ══════════════════════════════════════════════════════════════════════════════
// MENU INTEGRATION - Add this submenu to your existing onOpen()
// ══════════════════════════════════════════════════════════════════════════════

/*
 * ADD THIS TO YOUR EXISTING onOpen() FUNCTION, inside the menu creation:
 *
 *    .addSubMenu(SpreadsheetApp.getUi().createMenu('D. 🔄 MY POST RESPONSES')
 *      .addItem('📥 Fetch My Posts (RSS)', 'LR_fetchMyPosts')
 *      .addItem('💬 Process New Comments', 'LR_processComments')
 *      .addItem('🤖 Generate Responses', 'LR_generateResponses')
 *      .addItem('📤 Post Approved Replies', 'LR_postApprovedResponses')
 *      .addSeparator()
 *      .addItem('▶️ Run Full Workflow', 'LR_runFullWorkflow')
 *      .addItem('⏰ Setup Auto Triggers', 'LR_setupTriggers')
 *      .addItem('🧪 Test APIs', 'LR_testAPIs'))
 */

// ══════════════════════════════════════════════════════════════════════════════
// SHEET MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

function LR_getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#2d5a27').setFontColor('white');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function LR_setupSheets() {
  LR_getOrCreateSheet(LR_CONFIG.sheets.myPosts, [
    'PostURL', 'ActivityID', 'PostText', 'DateAdded', 'LastChecked', 'CommentCount'
  ]);

  LR_getOrCreateSheet(LR_CONFIG.sheets.myComments, [
    'ID', 'PostURL', 'ActivityID', 'CommentText', 'CommenterName', 'CommenterURL',
    'Headline', 'ProfileData', 'CommentURN', 'Status', 'DateFound'
  ]);

  LR_getOrCreateSheet(LR_CONFIG.sheets.myResponses, [
    'CommentID', 'OriginalComment', 'CommenterContext',
    'Draft1', 'Draft2', 'Draft3',
    'ClaudeChoice', 'GeminiCheck', 'FinalResponse',
    'Status', 'PostedAt', 'ResponseURN'
  ]);

  LR_getOrCreateSheet(LR_CONFIG.sheets.lrLog, [
    'Timestamp', 'Function', 'Status', 'Message'
  ]);

  LR_log('LR_setupSheets', 'SUCCESS', 'LinkedIn Responder sheets created');
  SpreadsheetApp.getActiveSpreadsheet().toast('✅ LinkedIn Responder sheets created!', 'Setup', 3);
}

function LR_log(func, status, message) {
  try {
    const sheet = LR_getOrCreateSheet(LR_CONFIG.sheets.lrLog, ['Timestamp', 'Function', 'Status', 'Message']);
    const msg = typeof message === 'object' ? JSON.stringify(message) : message;
    sheet.appendRow([new Date(), func, status, msg]);
  } catch (e) {
    Logger.log(`LR LOG: ${func} - ${status} - ${message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

function LR_findField(obj, possibleNames) {
  for (const name of possibleNames) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== '') {
      return obj[name];
    }
  }
  return '';
}

function LR_extractActivityId(url) {
  const match = url.match(/activity[:\-](\d+)/);
  return match ? match[1] : '';
}

function LR_generateCommentId(postUrl, commenterUrl, text) {
  const input = `${postUrl}|${commenterUrl}|${(text || '').substring(0, 50)}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'lr_' + Math.abs(hash).toString(36);
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. FETCH MY POSTS FROM RSS
// ══════════════════════════════════════════════════════════════════════════════

function LR_fetchMyPosts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!LR_CONFIG.rssFeedUrl) {
    ss.toast('❌ RSS_FEED_URL not configured in Script Properties', 'Error', 5);
    LR_log('LR_fetchMyPosts', 'ERROR', 'RSS_FEED_URL not set');
    return 0;
  }

  const sheet = LR_getOrCreateSheet(LR_CONFIG.sheets.myPosts, [
    'PostURL', 'ActivityID', 'PostText', 'DateAdded', 'LastChecked', 'CommentCount'
  ]);

  const existingUrls = new Set();
  const data = sheet.getDataRange().getValues();
  data.slice(1).forEach(row => existingUrls.add(row[0]));

  try {
    ss.toast('📡 Fetching RSS feed...', 'LinkedIn Responder', 2);

    const response = UrlFetchApp.fetch(LR_CONFIG.rssFeedUrl);
    const xml = XmlService.parse(response.getContentText());
    const root = xml.getRootElement();

    let items = [];
    const ns = root.getNamespace();

    if (root.getName() === 'rss') {
      const channel = root.getChild('channel');
      items = channel.getChildren('item');
    } else if (root.getName() === 'feed') {
      items = root.getChildren('entry', ns);
    }

    let added = 0;
    items.forEach(item => {
      let link, title;

      if (root.getName() === 'rss') {
        link = item.getChildText('link');
        title = item.getChildText('title') || '';
      } else {
        const linkEl = item.getChildren('link', ns).find(l =>
          l.getAttribute('rel')?.getValue() !== 'self'
        );
        link = linkEl?.getAttribute('href')?.getValue();
        title = item.getChildText('title', ns) || '';
      }

      if (link && !existingUrls.has(link)) {
        const activityId = LR_extractActivityId(link);
        sheet.appendRow([
          link,
          activityId,
          title.substring(0, 500),
          new Date(),
          '',
          0
        ]);
        added++;
      }
    });

    LR_log('LR_fetchMyPosts', 'SUCCESS', `Added ${added} new posts from RSS`);
    ss.toast(`✅ Found ${added} new posts from RSS`, 'LinkedIn Responder', 3);
    return added;

  } catch (error) {
    LR_log('LR_fetchMyPosts', 'ERROR', error.toString());
    ss.toast('❌ RSS fetch failed: ' + error.message, 'Error', 5);
    return 0;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHANTOMBUSTER API HELPER
// ══════════════════════════════════════════════════════════════════════════════

function LR_getPhantomOutput(agentId) {
  // Use existing PHANTOM config from your script, or fallback to Script Properties
  const apiKey = (typeof PHANTOM !== 'undefined' && PHANTOM.apiKey)
    ? PHANTOM.apiKey
    : PropertiesService.getScriptProperties().getProperty('PHANTOMBUSTER_API_KEY');

  if (!apiKey) {
    Logger.log('PhantomBuster API key not found');
    return null;
  }

  const response = UrlFetchApp.fetch(`https://api.phantombuster.com/api/v2/agents/fetch-output?id=${agentId}`, {
    method: 'GET',
    headers: { 'X-Phantombuster-Key': apiKey },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() === 200) {
    return JSON.parse(response.getContentText());
  }
  Logger.log('PhantomBuster error: ' + response.getContentText());
  return null;
}

function LR_launchPhantom(agentId, postUrls) {
  const apiKey = (typeof PHANTOM !== 'undefined' && PHANTOM.apiKey)
    ? PHANTOM.apiKey
    : PropertiesService.getScriptProperties().getProperty('PHANTOMBUSTER_API_KEY');

  if (!apiKey) return null;

  const response = UrlFetchApp.fetch('https://api.phantombuster.com/api/v2/agents/launch', {
    method: 'POST',
    headers: {
      'X-Phantombuster-Key': apiKey,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      id: agentId,
      argument: { spreadsheetUrl: postUrls }
    }),
    muteHttpExceptions: true
  });

  return response.getResponseCode() === 200;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. PROCESS COMMENTS (from PhantomBuster or manual entry)
// ══════════════════════════════════════════════════════════════════════════════

function LR_processComments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Check for PhantomBuster API key
  const hasPhantom = (typeof PHANTOM !== 'undefined' && PHANTOM.apiKey) ||
    PropertiesService.getScriptProperties().getProperty('PHANTOMBUSTER_API_KEY');

  // Try to get PhantomBuster results if configured
  if (LR_CONFIG.phantomCommenterAgentId && hasPhantom) {
    ss.toast('📥 Fetching PhantomBuster results...', 'LinkedIn Responder', 2);

    try {
      const output = LR_getPhantomOutput(LR_CONFIG.phantomCommenterAgentId);

      if (output && output.data && output.data.resultObject) {
        let results = JSON.parse(output.data.resultObject);
        if (!Array.isArray(results)) results = [results];

        const sheet = LR_getOrCreateSheet(LR_CONFIG.sheets.myComments, []);
        const existingIds = new Set();
        sheet.getDataRange().getValues().slice(1).forEach(row => existingIds.add(row[0]));

        let added = 0;
        results.forEach(item => {
          const postUrl = LR_findField(item, LR_FIELD_MAPS.postUrl);
          const commenterUrl = LR_findField(item, LR_FIELD_MAPS.profileUrl);
          const commentText = LR_findField(item, LR_FIELD_MAPS.commentText);
          const commenterName = LR_findField(item, LR_FIELD_MAPS.commenterName);
          const headline = LR_findField(item, LR_FIELD_MAPS.headline);
          const rawCommentId = LR_findField(item, LR_FIELD_MAPS.commentId);

          const id = LR_generateCommentId(postUrl, commenterUrl, commentText);

          if (existingIds.has(id) || !commentText) return;

          const activityId = LR_extractActivityId(postUrl);
          let commentUrn = '';
          if (rawCommentId && activityId) {
            commentUrn = `urn:li:comment:(urn:li:activity:${activityId},${rawCommentId})`;
          }

          sheet.appendRow([
            id, postUrl, activityId, commentText, commenterName, commenterUrl,
            headline, '', commentUrn, 'NEW', new Date()
          ]);
          added++;
        });

        LR_log('LR_processComments', 'SUCCESS', `Added ${added} new comments`);
        ss.toast(`✅ Added ${added} new comments`, 'LinkedIn Responder', 3);
        return added;
      }
    } catch (e) {
      LR_log('LR_processComments', 'ERROR', e.toString());
    }
  }

  ss.toast('ℹ️ Add comments manually to MY POST COMMENTS sheet, or configure PhantomBuster', 'LinkedIn Responder', 5);
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. GENERATE RESPONSES (GPT drafts → Claude picks → Gemini verifies)
// ══════════════════════════════════════════════════════════════════════════════

function LR_generateResponses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const commentsSheet = ss.getSheetByName(LR_CONFIG.sheets.myComments);

  if (!commentsSheet) {
    ss.toast('❌ No MY POST COMMENTS sheet found. Run "Process Comments" first.', 'Error', 5);
    return;
  }

  const responsesSheet = LR_getOrCreateSheet(LR_CONFIG.sheets.myResponses, []);

  const commentsData = commentsSheet.getDataRange().getValues();
  const existingResponses = new Set();
  responsesSheet.getDataRange().getValues().slice(1).forEach(row => existingResponses.add(row[0]));

  const toProcess = [];
  for (let i = 1; i < commentsData.length; i++) {
    const id = commentsData[i][0];
    const status = commentsData[i][9];

    if ((status === 'NEW' || !status) && !existingResponses.has(id)) {
      toProcess.push({
        id: id,
        commentText: commentsData[i][3],
        commenterName: commentsData[i][4],
        headline: commentsData[i][6],
        profileData: commentsData[i][7],
        row: i + 1
      });
    }
  }

  if (toProcess.length === 0) {
    ss.toast('ℹ️ No new comments to process', 'LinkedIn Responder', 3);
    return;
  }

  ss.toast(`🤖 Generating responses for ${toProcess.length} comments...`, 'LinkedIn Responder', 3);

  toProcess.forEach((comment, idx) => {
    try {
      ss.toast(`[${idx + 1}/${toProcess.length}] Processing: ${comment.commenterName}`, 'LinkedIn Responder', 2);

      const context = `Name: ${comment.commenterName}\nTitle: ${comment.headline || 'N/A'}`;

      // Step 1: GPT-4 generates 3 drafts (using your existing CONFIG.keys.openai)
      const gptPrompt = `You're JJ Shay, responding to a comment on your LinkedIn post. Be professional, authentic, concise (1-3 sentences).

COMMENTER: ${context}

THEIR COMMENT: "${comment.commentText}"

Write 3 different reply options:
1. Warm and appreciative
2. Adds insight or value
3. Asks an engaging follow-up question

Format exactly as:
DRAFT1: [reply]
DRAFT2: [reply]
DRAFT3: [reply]`;

      const gptResponse = LR_callOpenAI(gptPrompt);
      const drafts = LR_parseDrafts(gptResponse);

      // Step 2: Claude picks best (using your existing CONFIG.keys.anthropic)
      const claudePrompt = `Review these LinkedIn reply drafts. Pick the best one.

ORIGINAL COMMENT: "${comment.commentText}"
COMMENTER: ${comment.commenterName}

DRAFT 1: ${drafts[0]}
DRAFT 2: ${drafts[1]}
DRAFT 3: ${drafts[2]}

Respond EXACTLY as:
BEST: [1, 2, or 3]
REASON: [one sentence]
FINAL: [the polished reply]`;

      const claudeResponse = LR_callClaude(claudePrompt);
      const claudeFinal = LR_extractFinal(claudeResponse) || drafts[0];

      // Step 3: Gemini verification (using your existing CONFIG.keys.google)
      const geminiPrompt = `Quick check on this LinkedIn reply:

COMMENT: "${comment.commentText}"
REPLY: "${claudeFinal}"

Reply EXACTLY as:
OK: [yes or no]
FIXED: [the response to use]`;

      const geminiResponse = LR_callGemini(geminiPrompt);
      const finalResponse = LR_extractFixed(geminiResponse) || claudeFinal;

      // Save to responses sheet
      responsesSheet.appendRow([
        comment.id,
        comment.commentText,
        context,
        drafts[0], drafts[1], drafts[2],
        claudeResponse.substring(0, 400),
        geminiResponse.substring(0, 400),
        finalResponse,
        'REVIEW',
        '', ''
      ]);

      // Update comment status
      commentsSheet.getRange(comment.row, 10).setValue('PROCESSED');

      LR_log('LR_generateResponses', 'SUCCESS', { id: comment.id });
      Utilities.sleep(1000);

    } catch (error) {
      LR_log('LR_generateResponses', 'ERROR', { id: comment.id, error: error.toString() });
    }
  });

  ss.toast(`✅ Generated ${toProcess.length} responses. Review in MY RESPONSES sheet.`, 'LinkedIn Responder', 5);
}

// LLM Helpers (use your existing CONFIG.keys)
function LR_callOpenAI(prompt) {
  const r = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CONFIG.keys.openai}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You write authentic LinkedIn replies. Never be salesy.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500
    }),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() === 200) {
    return JSON.parse(r.getContentText()).choices[0].message.content;
  }
  LR_log('LR_callOpenAI', 'ERROR', `Status ${r.getResponseCode()}: ${r.getContentText().substring(0, 200)}`);
  return '';
}

function LR_callClaude(prompt) {
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CONFIG.keys.anthropic,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() === 200) {
    return JSON.parse(r.getContentText()).content[0].text;
  }
  LR_log('LR_callClaude', 'ERROR', `Status ${r.getResponseCode()}: ${r.getContentText().substring(0, 200)}`);
  return '';
}

function LR_callGemini(prompt) {
  const r = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${CONFIG.keys.google}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
      }),
      muteHttpExceptions: true
    }
  );
  if (r.getResponseCode() === 200) {
    return JSON.parse(r.getContentText()).candidates[0].content.parts[0].text;
  }
  LR_log('LR_callGemini', 'ERROR', `Status ${r.getResponseCode()}: ${r.getContentText().substring(0, 200)}`);
  return '';
}

function LR_parseDrafts(response) {
  const drafts = ['', '', ''];
  const matches = response.match(/DRAFT(\d):\s*(.+?)(?=DRAFT\d:|$)/gs);
  if (matches) {
    matches.forEach(m => {
      const num = m.match(/DRAFT(\d)/)?.[1];
      const text = m.replace(/DRAFT\d:\s*/, '').trim();
      if (num && parseInt(num) <= 3) drafts[parseInt(num) - 1] = text;
    });
  }
  return drafts;
}

function LR_extractFinal(text) {
  const match = text.match(/FINAL:\s*(.+?)(?=\n\n|$)/s);
  return match ? match[1].trim() : '';
}

function LR_extractFixed(text) {
  const match = text.match(/FIXED:\s*(.+?)(?=\n\n|$)/s);
  return match ? match[1].trim() : '';
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. POST APPROVED RESPONSES TO LINKEDIN
// ══════════════════════════════════════════════════════════════════════════════

function LR_postApprovedResponses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const responsesSheet = ss.getSheetByName(LR_CONFIG.sheets.myResponses);
  const commentsSheet = ss.getSheetByName(LR_CONFIG.sheets.myComments);

  if (!responsesSheet || !commentsSheet) {
    ss.toast('❌ Required sheets not found', 'Error', 5);
    return;
  }

  const linkedinToken = PropertiesService.getScriptProperties().getProperty('LINKEDIN_ACCESS_TOKEN');
  if (!linkedinToken) {
    ss.toast('❌ LINKEDIN_ACCESS_TOKEN not set in Script Properties', 'Error', 5);
    return;
  }

  // Get person URN
  let personUrn;
  try {
    const r = UrlFetchApp.fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${linkedinToken}`, 'LinkedIn-Version': '202401' },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200) {
      const data = JSON.parse(r.getContentText());
      personUrn = `urn:li:person:${data.sub}`;
    } else {
      ss.toast('❌ LinkedIn token invalid or expired', 'Error', 5);
      return;
    }
  } catch (e) {
    ss.toast('❌ LinkedIn API error: ' + e.message, 'Error', 5);
    return;
  }

  const responsesData = responsesSheet.getDataRange().getValues();
  const commentsData = commentsSheet.getDataRange().getValues();

  // Build lookup
  const commentLookup = {};
  commentsData.slice(1).forEach(row => {
    commentLookup[row[0]] = { activityId: row[2], commentUrn: row[8] };
  });

  let posted = 0;

  for (let i = 1; i < responsesData.length; i++) {
    const status = responsesData[i][9];

    if (status === 'APPROVED') {
      const commentId = responsesData[i][0];
      const finalResponse = responsesData[i][8];
      const lookup = commentLookup[commentId];

      if (!lookup?.activityId || !finalResponse) {
        responsesSheet.getRange(i + 1, 10).setValue('FAILED_MISSING_DATA');
        continue;
      }

      try {
        const activityUrn = `urn:li:activity:${lookup.activityId}`;

        const payload = {
          actor: personUrn,
          object: activityUrn,
          message: { text: finalResponse }
        };

        if (lookup.commentUrn) {
          payload.parentComment = lookup.commentUrn;
        }

        const endpoint = lookup.commentUrn
          ? `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(lookup.commentUrn)}/comments`
          : `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(activityUrn)}/comments`;

        const r = UrlFetchApp.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${linkedinToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401'
          },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });

        if (r.getResponseCode() >= 200 && r.getResponseCode() < 300) {
          const result = JSON.parse(r.getContentText());
          responsesSheet.getRange(i + 1, 10).setValue('POSTED');
          responsesSheet.getRange(i + 1, 11).setValue(new Date());
          responsesSheet.getRange(i + 1, 12).setValue(result.commentUrn || '');
          posted++;
          LR_log('LR_postApprovedResponses', 'SUCCESS', { commentId });
        } else {
          responsesSheet.getRange(i + 1, 10).setValue('FAILED');
          LR_log('LR_postApprovedResponses', 'ERROR', { commentId, error: r.getContentText() });
        }

        Utilities.sleep(2000);

      } catch (error) {
        responsesSheet.getRange(i + 1, 10).setValue('FAILED');
        LR_log('LR_postApprovedResponses', 'ERROR', { commentId, error: error.toString() });
      }
    }
  }

  ss.toast(`✅ Posted ${posted} responses to LinkedIn`, 'LinkedIn Responder', 5);
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW & TRIGGERS
// ══════════════════════════════════════════════════════════════════════════════

function LR_runFullWorkflow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('🔄 Starting LinkedIn Responder workflow...', 'LinkedIn Responder', 3);

  LR_setupSheets();
  LR_fetchMyPosts();
  LR_processComments();
  LR_generateResponses();

  ss.toast('✅ Workflow complete! Review MY RESPONSES, set status to APPROVED, then run "Post Approved Replies"', 'LinkedIn Responder', 10);
}

function LR_setupTriggers() {
  // Remove existing LR triggers
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction().startsWith('LR_')) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Run workflow every 4 hours
  ScriptApp.newTrigger('LR_runFullWorkflow')
    .timeBased()
    .everyHours(4)
    .create();

  // Post approved responses every 6 hours
  ScriptApp.newTrigger('LR_postApprovedResponses')
    .timeBased()
    .everyHours(6)
    .create();

  LR_log('LR_setupTriggers', 'SUCCESS', 'Triggers configured');
  SpreadsheetApp.getActiveSpreadsheet().toast('✅ Auto triggers set up!', 'LinkedIn Responder', 3);
}

function LR_testAPIs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = [];

  // Test OpenAI (via your CONFIG)
  try {
    LR_callOpenAI('Say OK');
    results.push('✅ OpenAI');
  } catch (e) {
    results.push('❌ OpenAI: ' + e.message);
  }

  // Test Claude (via your CONFIG)
  try {
    LR_callClaude('Say OK');
    results.push('✅ Claude');
  } catch (e) {
    results.push('❌ Claude: ' + e.message);
  }

  // Test Gemini (via your CONFIG)
  try {
    LR_callGemini('Say OK');
    results.push('✅ Gemini');
  } catch (e) {
    results.push('❌ Gemini: ' + e.message);
  }

  // Test LinkedIn
  const linkedinToken = PropertiesService.getScriptProperties().getProperty('LINKEDIN_ACCESS_TOKEN');
  if (linkedinToken) {
    try {
      const r = UrlFetchApp.fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${linkedinToken}`, 'LinkedIn-Version': '202401' },
        muteHttpExceptions: true
      });
      results.push(r.getResponseCode() === 200 ? '✅ LinkedIn' : '❌ LinkedIn: Invalid token');
    } catch (e) {
      results.push('❌ LinkedIn: ' + e.message);
    }
  } else {
    results.push('⚠️ LinkedIn: Token not configured');
  }

  // Test RSS
  if (LR_CONFIG.rssFeedUrl) {
    try {
      const r = UrlFetchApp.fetch(LR_CONFIG.rssFeedUrl, { muteHttpExceptions: true });
      results.push(r.getResponseCode() === 200 ? '✅ RSS Feed' : '❌ RSS Feed');
    } catch (e) {
      results.push('❌ RSS: ' + e.message);
    }
  } else {
    results.push('⚠️ RSS: Not configured');
  }

  SpreadsheetApp.getUi().alert('LinkedIn Responder API Test', results.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER: Approve all pending responses
// ══════════════════════════════════════════════════════════════════════════════

function LR_approveAllPending() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LR_CONFIG.sheets.myResponses);
  if (!sheet) return 0;

  const data = sheet.getDataRange().getValues();
  let count = 0;

  for (let i = 1; i < data.length; i++) {
    if (data[i][9] === 'REVIEW') {
      sheet.getRange(i + 1, 10).setValue('APPROVED');
      count++;
    }
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(`✅ Approved ${count} responses`, 'LinkedIn Responder', 3);
  return count;
}
