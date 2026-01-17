/**
 * LinkedIn Comment Auto-Responder v2
 *
 * Production-ready with flexible field mapping and auto-detection
 */

// ============================================
// CONFIGURATION
// ============================================

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    phantombuster: {
      apiKey: props.getProperty('PHANTOMBUSTER_API_KEY'),
      commenterAgentId: props.getProperty('PHANTOMBUSTER_COMMENTER_AGENT_ID'),
      profileAgentId: props.getProperty('PHANTOMBUSTER_PROFILE_AGENT_ID'),
      autoCommenterAgentId: props.getProperty('PHANTOMBUSTER_AUTO_COMMENTER_AGENT_ID')
    },
    linkedin: {
      accessToken: props.getProperty('LINKEDIN_ACCESS_TOKEN'),
      personUrn: props.getProperty('LINKEDIN_PERSON_URN') // Cache this after first lookup
    },
    openai: {
      apiKey: props.getProperty('OPENAI_API_KEY')
    },
    anthropic: {
      apiKey: props.getProperty('ANTHROPIC_API_KEY')
    },
    googleAi: {
      apiKey: props.getProperty('GOOGLE_AI_KEY')
    },
    rssFeedUrl: props.getProperty('RSS_FEED_URL')
  };
}

// Field mappings - adjust these based on actual PhantomBuster output
const FIELD_MAPS = {
  commentExport: {
    // PhantomBuster field -> our internal field
    possibleFields: {
      profileUrl: ['profileUrl', 'linkedinUrl', 'profile', 'url', 'linkedin'],
      commentText: ['commentText', 'comment', 'text', 'message', 'content'],
      commenterName: ['fullName', 'name', 'commenterName', 'firstName', 'displayName'],
      postUrl: ['postUrl', 'sourceUrl', 'originalPost', 'post', 'articleUrl'],
      headline: ['headline', 'job', 'jobTitle', 'title', 'occupation'],
      timestamp: ['timestamp', 'date', 'commentDate', 'createdAt', 'time'],
      commentId: ['commentId', 'id', 'urn', 'commentUrn']
    }
  },
  profileScraper: {
    possibleFields: {
      profileUrl: ['profileUrl', 'linkedinUrl', 'query', 'url'],
      fullName: ['fullName', 'name', 'displayName'],
      headline: ['headline', 'job', 'jobTitle', 'currentJob'],
      company: ['company', 'companyName', 'currentCompany', 'organization'],
      location: ['location', 'city', 'region'],
      about: ['about', 'summary', 'description', 'bio'],
      connections: ['connections', 'connectionsCount'],
      followers: ['followers', 'followersCount']
    }
  }
};

// ============================================
// SHEET MANAGEMENT
// ============================================

const SHEETS = {
  POSTS: 'Posts',
  COMMENTS: 'Comments',
  RESPONSES: 'Responses',
  LOG: 'Log',
  CONFIG: 'Config'
};

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#4a86e8').setFontColor('white');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function setupSheets() {
  getOrCreateSheet(SHEETS.POSTS, [
    'PostURL', 'ActivityID', 'PostText', 'DateAdded', 'LastChecked', 'CommentCount'
  ]);

  getOrCreateSheet(SHEETS.COMMENTS, [
    'ID', 'PostURL', 'ActivityID', 'CommentText', 'CommenterName', 'CommenterURL',
    'Headline', 'Company', 'ProfileJSON', 'CommentURN', 'Status', 'DateFound'
  ]);

  getOrCreateSheet(SHEETS.RESPONSES, [
    'CommentID', 'OriginalComment', 'CommenterContext',
    'Draft1', 'Draft2', 'Draft3',
    'ClaudeChoice', 'GeminiCheck', 'FinalResponse',
    'Status', 'PostedAt', 'ResponseURN'
  ]);

  getOrCreateSheet(SHEETS.LOG, [
    'Timestamp', 'Function', 'Status', 'Message'
  ]);

  getOrCreateSheet(SHEETS.CONFIG, [
    'Key', 'Value', 'Description'
  ]);

  // Add default config values
  const configSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CONFIG);
  const configData = configSheet.getDataRange().getValues();
  if (configData.length <= 1) {
    configSheet.getRange(2, 1, 4, 3).setValues([
      ['AUTO_APPROVE', 'false', 'Set to true to skip manual approval'],
      ['MAX_RESPONSES_PER_RUN', '5', 'Limit responses generated per run'],
      ['RESPONSE_TONE', 'professional', 'Tone for generated responses'],
      ['SKIP_PROFILE_SCRAPE', 'false', 'Set to true to skip profile enrichment']
    ]);
  }

  log('setupSheets', 'SUCCESS', 'All sheets created');
}

function log(func, status, message) {
  try {
    const sheet = getOrCreateSheet(SHEETS.LOG, ['Timestamp', 'Function', 'Status', 'Message']);
    const msg = typeof message === 'object' ? JSON.stringify(message) : message;
    sheet.appendRow([new Date(), func, status, msg]);
  } catch (e) {
    console.log(`LOG ERROR: ${func} - ${status} - ${message}`);
  }
}

function getConfigValue(key, defaultValue = '') {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CONFIG);
  if (!sheet) return defaultValue;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1] || defaultValue;
  }
  return defaultValue;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function findField(obj, possibleNames) {
  for (const name of possibleNames) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== '') {
      return obj[name];
    }
  }
  return '';
}

function extractActivityId(url) {
  // Match patterns like: activity-7417158378638057472 or activity:7417158378638057472
  const match = url.match(/activity[:\-](\d+)/);
  return match ? match[1] : '';
}

function generateCommentId(postUrl, commenterUrl, text) {
  // Create deterministic ID
  const input = `${postUrl}|${commenterUrl}|${(text || '').substring(0, 50)}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'cmt_' + Math.abs(hash).toString(36);
}

function constructCommentUrn(activityId, commentId) {
  if (!activityId || !commentId) return '';
  return `urn:li:comment:(urn:li:activity:${activityId},${commentId})`;
}

// ============================================
// RSS FEED PROCESSING
// ============================================

function fetchRSSPosts() {
  const config = getConfig();
  if (!config.rssFeedUrl) {
    log('fetchRSSPosts', 'ERROR', 'RSS_FEED_URL not set');
    return 0;
  }

  const sheet = getOrCreateSheet(SHEETS.POSTS, []);
  const existingUrls = new Set();
  const data = sheet.getDataRange().getValues();
  data.slice(1).forEach(row => existingUrls.add(row[0]));

  try {
    const response = UrlFetchApp.fetch(config.rssFeedUrl);
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
        const activityId = extractActivityId(link);
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

    log('fetchRSSPosts', 'SUCCESS', `Added ${added} new posts`);
    return added;

  } catch (error) {
    log('fetchRSSPosts', 'ERROR', error.toString());
    return 0;
  }
}

// ============================================
// PHANTOMBUSTER API
// ============================================

function phantomRequest(endpoint, method, payload = null) {
  const config = getConfig();

  const options = {
    method: method,
    headers: {
      'X-Phantombuster-Key': config.phantombuster.apiKey,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };

  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(
    `https://api.phantombuster.com/api/v2${endpoint}`,
    options
  );

  return JSON.parse(response.getContentText());
}

function launchPhantom(agentId, args = null) {
  const payload = { id: agentId };
  if (args) payload.argument = JSON.stringify(args);
  return phantomRequest('/agents/launch', 'POST', payload);
}

function getPhantomOutput(agentId) {
  return phantomRequest(`/agents/fetch-output?id=${agentId}`, 'GET');
}

function triggerCommentScrape() {
  const config = getConfig();
  if (!config.phantombuster.commenterAgentId) {
    log('triggerCommentScrape', 'ERROR', 'PHANTOMBUSTER_COMMENTER_AGENT_ID not set');
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.POSTS);
  const data = sheet.getDataRange().getValues();

  // Get posts not checked in last 4 hours
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const postsToCheck = [];

  for (let i = 1; i < data.length; i++) {
    const lastChecked = data[i][4];
    if (!lastChecked || new Date(lastChecked) < cutoff) {
      postsToCheck.push({ url: data[i][0], row: i + 1 });
    }
  }

  if (postsToCheck.length === 0) {
    log('triggerCommentScrape', 'INFO', 'No posts need checking');
    return;
  }

  // Update last checked
  postsToCheck.forEach(p => {
    sheet.getRange(p.row, 5).setValue(new Date());
  });

  // Launch phantom (it should be configured to read from your Google Sheet)
  const result = launchPhantom(config.phantombuster.commenterAgentId);
  log('triggerCommentScrape', 'SUCCESS', { posts: postsToCheck.length, result });
}

function processCommentResults() {
  const config = getConfig();
  if (!config.phantombuster.commenterAgentId) return;

  const output = getPhantomOutput(config.phantombuster.commenterAgentId);

  if (!output.data?.resultObject) {
    log('processCommentResults', 'INFO', 'No results available');
    return 0;
  }

  let results;
  try {
    results = JSON.parse(output.data.resultObject);
  } catch (e) {
    log('processCommentResults', 'ERROR', 'Failed to parse results: ' + e.toString());
    return 0;
  }

  if (!Array.isArray(results)) {
    results = [results];
  }

  // Log first result to see actual field names
  if (results.length > 0) {
    log('processCommentResults', 'DEBUG', 'Sample fields: ' + Object.keys(results[0]).join(', '));
  }

  const sheet = getOrCreateSheet(SHEETS.COMMENTS, []);
  const existingIds = new Set();
  sheet.getDataRange().getValues().slice(1).forEach(row => existingIds.add(row[0]));

  const fields = FIELD_MAPS.commentExport.possibleFields;
  let added = 0;

  results.forEach(item => {
    const postUrl = findField(item, fields.postUrl);
    const commenterUrl = findField(item, fields.profileUrl);
    const commentText = findField(item, fields.commentText);
    const commenterName = findField(item, fields.commenterName);
    const headline = findField(item, fields.headline);
    const rawCommentId = findField(item, fields.commentId);

    const id = generateCommentId(postUrl, commenterUrl, commentText);

    if (existingIds.has(id)) return;

    const activityId = extractActivityId(postUrl);
    const commentUrn = rawCommentId ? constructCommentUrn(activityId, rawCommentId) : '';

    sheet.appendRow([
      id,
      postUrl,
      activityId,
      commentText,
      commenterName,
      commenterUrl,
      headline,
      '', // company - from profile scrape
      '', // profileJSON
      commentUrn,
      'NEW',
      new Date()
    ]);

    added++;
  });

  log('processCommentResults', 'SUCCESS', `Added ${added} new comments`);
  return added;
}

function scrapeProfiles() {
  const config = getConfig();
  if (!config.phantombuster.profileAgentId) {
    log('scrapeProfiles', 'SKIP', 'No profile agent configured');
    return;
  }

  if (getConfigValue('SKIP_PROFILE_SCRAPE', 'false') === 'true') {
    log('scrapeProfiles', 'SKIP', 'Profile scraping disabled in config');
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMMENTS);
  const data = sheet.getDataRange().getValues();

  const profilesToScrape = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][10] === 'NEW' && data[i][5] && !data[i][8]) {
      profilesToScrape.push(data[i][5]);
    }
  }

  if (profilesToScrape.length === 0) {
    log('scrapeProfiles', 'INFO', 'No profiles to scrape');
    return;
  }

  const result = launchPhantom(config.phantombuster.profileAgentId);
  log('scrapeProfiles', 'SUCCESS', { profiles: profilesToScrape.length, result });
}

function processProfileResults() {
  const config = getConfig();
  if (!config.phantombuster.profileAgentId) return;

  const output = getPhantomOutput(config.phantombuster.profileAgentId);

  if (!output.data?.resultObject) {
    log('processProfileResults', 'INFO', 'No profile results');
    return;
  }

  let profiles;
  try {
    profiles = JSON.parse(output.data.resultObject);
  } catch (e) {
    log('processProfileResults', 'ERROR', 'Failed to parse: ' + e.toString());
    return;
  }

  if (!Array.isArray(profiles)) profiles = [profiles];

  if (profiles.length > 0) {
    log('processProfileResults', 'DEBUG', 'Profile fields: ' + Object.keys(profiles[0]).join(', '));
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMMENTS);
  const data = sheet.getDataRange().getValues();
  const fields = FIELD_MAPS.profileScraper.possibleFields;

  let updated = 0;
  profiles.forEach(profile => {
    const profileUrl = findField(profile, fields.profileUrl);

    for (let i = 1; i < data.length; i++) {
      if (data[i][5] === profileUrl || data[i][5].includes(profileUrl) || profileUrl.includes(data[i][5])) {
        const company = findField(profile, fields.company);
        const about = findField(profile, fields.about);

        if (company) sheet.getRange(i + 1, 8).setValue(company);

        const profileJson = JSON.stringify({
          headline: findField(profile, fields.headline),
          company: company,
          location: findField(profile, fields.location),
          about: about,
          connections: findField(profile, fields.connections),
          followers: findField(profile, fields.followers)
        });

        sheet.getRange(i + 1, 9).setValue(profileJson);
        sheet.getRange(i + 1, 11).setValue('READY');
        updated++;
      }
    }
  });

  log('processProfileResults', 'SUCCESS', `Updated ${updated} profiles`);
}

// ============================================
// LLM INTEGRATIONS
// ============================================

function callOpenAI(messages, temperature = 0.8) {
  const config = getConfig();

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'gpt-4o',
      messages: messages,
      temperature: temperature,
      max_tokens: 600
    }),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());
  if (result.error) throw new Error('OpenAI: ' + result.error.message);
  return result.choices[0].message.content;
}

function callClaude(prompt, system = '') {
  const config = getConfig();

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: system,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());
  if (result.error) throw new Error('Claude: ' + result.error.message);
  return result.content[0].text;
}

function callGemini(prompt) {
  const config = getConfig();

  const response = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${config.googleAi.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 600 }
      }),
      muteHttpExceptions: true
    }
  );

  const result = JSON.parse(response.getContentText());
  if (result.error) throw new Error('Gemini: ' + result.error.message);
  return result.candidates[0].content.parts[0].text;
}

// ============================================
// RESPONSE GENERATION
// ============================================

function generateResponses() {
  const commentsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMMENTS);
  const responsesSheet = getOrCreateSheet(SHEETS.RESPONSES, []);

  const commentsData = commentsSheet.getDataRange().getValues();
  const existingResponses = new Set();
  responsesSheet.getDataRange().getValues().slice(1).forEach(row => existingResponses.add(row[0]));

  const maxPerRun = parseInt(getConfigValue('MAX_RESPONSES_PER_RUN', '5'));
  const tone = getConfigValue('RESPONSE_TONE', 'professional');

  const toProcess = [];
  for (let i = 1; i < commentsData.length; i++) {
    const id = commentsData[i][0];
    const status = commentsData[i][10];

    if ((status === 'READY' || status === 'NEW') && !existingResponses.has(id)) {
      toProcess.push({
        id: id,
        commentText: commentsData[i][3],
        commenterName: commentsData[i][4],
        headline: commentsData[i][6],
        company: commentsData[i][7],
        profileJson: commentsData[i][8],
        row: i + 1
      });
    }

    if (toProcess.length >= maxPerRun) break;
  }

  if (toProcess.length === 0) {
    log('generateResponses', 'INFO', 'No comments to process');
    return;
  }

  toProcess.forEach(comment => {
    try {
      // Build context
      let profileContext = '';
      if (comment.profileJson) {
        try {
          const p = JSON.parse(comment.profileJson);
          profileContext = `About: ${p.about || 'N/A'}\nLocation: ${p.location || 'N/A'}`;
        } catch (e) {}
      }

      const context = `Name: ${comment.commenterName}
Title: ${comment.headline || 'Not specified'}
Company: ${comment.company || 'Not specified'}
${profileContext}`;

      // Step 1: GPT-4 generates 3 drafts
      const gptPrompt = `You're crafting LinkedIn comment replies. Be ${tone}, authentic, and concise (1-3 sentences).

COMMENTER:
${context}

THEIR COMMENT:
"${comment.commentText}"

Write 3 different reply options:
1. Appreciative/warm
2. Adds insight or value
3. Asks an engaging follow-up question

Format exactly as:
DRAFT1: [reply]
DRAFT2: [reply]
DRAFT3: [reply]`;

      const gptResponse = callOpenAI([
        { role: 'system', content: 'You write authentic LinkedIn replies. Never be salesy. Be human.' },
        { role: 'user', content: gptPrompt }
      ]);

      // Parse drafts
      const drafts = ['', '', ''];
      const matches = gptResponse.match(/DRAFT(\d):\s*(.+?)(?=DRAFT\d:|$)/gs);
      if (matches) {
        matches.forEach(m => {
          const num = m.match(/DRAFT(\d)/)?.[1];
          const text = m.replace(/DRAFT\d:\s*/, '').trim();
          if (num && parseInt(num) <= 3) drafts[parseInt(num) - 1] = text;
        });
      }

      // Step 2: Claude picks the best and refines
      const claudePrompt = `Review these LinkedIn reply drafts. Pick the best one and improve it if needed.

ORIGINAL COMMENT: "${comment.commentText}"
COMMENTER: ${comment.commenterName} (${comment.headline})

DRAFT 1: ${drafts[0]}
DRAFT 2: ${drafts[1]}
DRAFT 3: ${drafts[2]}

Evaluate: authenticity, relevance, personalization, engagement potential.

Respond EXACTLY as:
BEST: [1, 2, or 3]
REASON: [one sentence]
FINAL: [the polished reply to use]`;

      const claudeResponse = callClaude(claudePrompt, 'You are an expert at authentic professional communication.');

      // Extract Claude's choice
      const bestMatch = claudeResponse.match(/BEST:\s*(\d)/);
      const finalMatch = claudeResponse.match(/FINAL:\s*(.+?)(?=\n\n|$)/s);
      const claudeFinal = finalMatch ? finalMatch[1].trim() : drafts[0];

      // Step 3: Gemini verification
      const geminiPrompt = `Quick check on this LinkedIn reply:

ORIGINAL COMMENT: "${comment.commentText}"
REPLY: "${claudeFinal}"

Does this sound:
1. Natural and human (not AI-generated)?
2. Professional yet warm?
3. Appropriate for LinkedIn?

Reply EXACTLY as:
OK: [yes or no]
ISSUE: [if no, what's wrong]
FIXED: [the response to use - same or improved]`;

      const geminiResponse = callGemini(geminiPrompt);

      // Extract final response
      const fixedMatch = geminiResponse.match(/FIXED:\s*(.+?)(?=\n\n|$)/s);
      const finalResponse = fixedMatch ? fixedMatch[1].trim() : claudeFinal;

      // Determine status
      const autoApprove = getConfigValue('AUTO_APPROVE', 'false') === 'true';
      const status = autoApprove ? 'APPROVED' : 'REVIEW';

      // Save to sheet
      responsesSheet.appendRow([
        comment.id,
        comment.commentText,
        context,
        drafts[0],
        drafts[1],
        drafts[2],
        claudeResponse.substring(0, 500),
        geminiResponse.substring(0, 500),
        finalResponse,
        status,
        '',
        ''
      ]);

      // Update comment status
      commentsSheet.getRange(comment.row, 11).setValue('PROCESSED');

      log('generateResponses', 'SUCCESS', { id: comment.id });

      // Rate limit protection
      Utilities.sleep(1000);

    } catch (error) {
      log('generateResponses', 'ERROR', { id: comment.id, error: error.toString() });
    }
  });
}

// ============================================
// LINKEDIN API - POST REPLIES
// ============================================

function getLinkedInPersonUrn() {
  const config = getConfig();

  // Check cache first
  if (config.linkedin.personUrn) {
    return config.linkedin.personUrn;
  }

  const response = UrlFetchApp.fetch('https://api.linkedin.com/v2/userinfo', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.linkedin.accessToken}`,
      'LinkedIn-Version': '202401'
    },
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (result.sub) {
    const urn = `urn:li:person:${result.sub}`;
    // Cache it
    PropertiesService.getScriptProperties().setProperty('LINKEDIN_PERSON_URN', urn);
    return urn;
  }

  throw new Error('Could not get LinkedIn person URN: ' + response.getContentText());
}

function postLinkedInReply(activityId, parentCommentUrn, replyText, actorUrn) {
  const config = getConfig();

  const activityUrn = `urn:li:activity:${activityId}`;

  const payload = {
    actor: actorUrn,
    object: activityUrn,
    message: { text: replyText }
  };

  // If we have a parent comment URN, this is a reply to a comment
  if (parentCommentUrn) {
    payload.parentComment = parentCommentUrn;
  }

  const endpoint = parentCommentUrn
    ? `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(parentCommentUrn)}/comments`
    : `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(activityUrn)}/comments`;

  const response = UrlFetchApp.fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.linkedin.accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202401'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code >= 400) {
    throw new Error(`LinkedIn API ${code}: ${body}`);
  }

  return JSON.parse(body);
}

function postApprovedResponses() {
  const responsesSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.RESPONSES);
  const commentsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMMENTS);

  if (!responsesSheet || !commentsSheet) {
    log('postApprovedResponses', 'ERROR', 'Sheets not found');
    return;
  }

  const responsesData = responsesSheet.getDataRange().getValues();
  const commentsData = commentsSheet.getDataRange().getValues();

  // Build lookup: commentId -> { activityId, commentUrn }
  const commentLookup = {};
  commentsData.slice(1).forEach(row => {
    commentLookup[row[0]] = {
      activityId: row[2],
      commentUrn: row[9]
    };
  });

  let actorUrn;
  try {
    actorUrn = getLinkedInPersonUrn();
  } catch (e) {
    log('postApprovedResponses', 'ERROR', 'Failed to get person URN: ' + e.toString());
    return;
  }

  let posted = 0;

  for (let i = 1; i < responsesData.length; i++) {
    const status = responsesData[i][9];

    if (status === 'APPROVED') {
      const commentId = responsesData[i][0];
      const finalResponse = responsesData[i][8];
      const lookup = commentLookup[commentId];

      if (!lookup?.activityId) {
        log('postApprovedResponses', 'ERROR', { commentId, error: 'No activity ID' });
        responsesSheet.getRange(i + 1, 10).setValue('FAILED_NO_ACTIVITY');
        continue;
      }

      if (!finalResponse) {
        log('postApprovedResponses', 'ERROR', { commentId, error: 'No response text' });
        responsesSheet.getRange(i + 1, 10).setValue('FAILED_NO_TEXT');
        continue;
      }

      try {
        const result = postLinkedInReply(
          lookup.activityId,
          lookup.commentUrn, // May be empty - will post top-level comment
          finalResponse,
          actorUrn
        );

        responsesSheet.getRange(i + 1, 10).setValue('POSTED');
        responsesSheet.getRange(i + 1, 11).setValue(new Date());
        responsesSheet.getRange(i + 1, 12).setValue(result.commentUrn || result.id || '');

        log('postApprovedResponses', 'SUCCESS', { commentId });
        posted++;

        Utilities.sleep(2000); // Rate limit

      } catch (error) {
        responsesSheet.getRange(i + 1, 10).setValue('FAILED');
        log('postApprovedResponses', 'ERROR', { commentId, error: error.toString() });
      }
    }
  }

  log('postApprovedResponses', 'COMPLETE', `Posted ${posted} responses`);
}

// ============================================
// MAIN WORKFLOWS
// ============================================

function runDiscovery() {
  log('runDiscovery', 'START', '');
  fetchRSSPosts();
  triggerCommentScrape();
  log('runDiscovery', 'COMPLETE', '');
}

function runProcessing() {
  log('runProcessing', 'START', '');
  processCommentResults();
  scrapeProfiles();
  processProfileResults();
  generateResponses();
  log('runProcessing', 'COMPLETE', '');
}

function runPosting() {
  log('runPosting', 'START', '');
  postApprovedResponses();
  log('runPosting', 'COMPLETE', '');
}

function runAll() {
  runDiscovery();
  Utilities.sleep(5000);
  runProcessing();
  runPosting();
}

function setupTriggers() {
  // Clear existing
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Discovery: every 6 hours
  ScriptApp.newTrigger('runDiscovery').timeBased().everyHours(6).create();

  // Processing: every 2 hours
  ScriptApp.newTrigger('runProcessing').timeBased().everyHours(2).create();

  // Posting: every 4 hours
  ScriptApp.newTrigger('runPosting').timeBased().everyHours(4).create();

  log('setupTriggers', 'SUCCESS', 'Triggers configured');
}

// ============================================
// MENU & TESTING
// ============================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🔄 LinkedIn Responder')
    .addItem('📋 Setup Sheets', 'setupSheets')
    .addItem('⏰ Setup Triggers', 'setupTriggers')
    .addSeparator()
    .addItem('🔍 Fetch RSS Posts', 'fetchRSSPosts')
    .addItem('💬 Trigger Comment Scrape', 'triggerCommentScrape')
    .addItem('📥 Process Comments', 'processCommentResults')
    .addItem('👤 Scrape Profiles', 'scrapeProfiles')
    .addItem('📥 Process Profiles', 'processProfileResults')
    .addItem('🤖 Generate Responses', 'generateResponses')
    .addItem('📤 Post Approved', 'postApprovedResponses')
    .addSeparator()
    .addItem('▶️ Run All', 'runAll')
    .addItem('🧪 Test APIs', 'testAPIs')
    .addToUi();
}

function testAPIs() {
  const results = { openai: 'SKIP', anthropic: 'SKIP', gemini: 'SKIP', linkedin: 'SKIP', phantombuster: 'SKIP' };
  const config = getConfig();

  // OpenAI
  if (config.openai.apiKey) {
    try {
      callOpenAI([{ role: 'user', content: 'Say OK' }]);
      results.openai = 'OK';
    } catch (e) {
      results.openai = 'FAIL: ' + e.message;
    }
  }

  // Anthropic
  if (config.anthropic.apiKey) {
    try {
      callClaude('Say OK');
      results.anthropic = 'OK';
    } catch (e) {
      results.anthropic = 'FAIL: ' + e.message;
    }
  }

  // Gemini
  if (config.googleAi.apiKey) {
    try {
      callGemini('Say OK');
      results.gemini = 'OK';
    } catch (e) {
      results.gemini = 'FAIL: ' + e.message;
    }
  }

  // LinkedIn
  if (config.linkedin.accessToken) {
    try {
      getLinkedInPersonUrn();
      results.linkedin = 'OK';
    } catch (e) {
      results.linkedin = 'FAIL: ' + e.message;
    }
  }

  // PhantomBuster
  if (config.phantombuster.apiKey) {
    try {
      const r = phantomRequest('/user', 'GET');
      results.phantombuster = r.status === 'success' ? 'OK' : 'FAIL';
    } catch (e) {
      results.phantombuster = 'FAIL: ' + e.message;
    }
  }

  log('testAPIs', 'RESULTS', results);

  // Show results
  const msg = Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('\n');
  SpreadsheetApp.getUi().alert('API Test Results', msg, SpreadsheetApp.getUi().ButtonSet.OK);

  return results;
}

function approveResponse(commentId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.RESPONSES);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === commentId) {
      sheet.getRange(i + 1, 10).setValue('APPROVED');
      return true;
    }
  }
  return false;
}

function approveAllPending() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.RESPONSES);
  const data = sheet.getDataRange().getValues();
  let count = 0;

  for (let i = 1; i < data.length; i++) {
    if (data[i][9] === 'REVIEW') {
      sheet.getRange(i + 1, 10).setValue('APPROVED');
      count++;
    }
  }

  log('approveAllPending', 'SUCCESS', `Approved ${count} responses`);
  return count;
}
