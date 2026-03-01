export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password, instruction } = req.body || {};

  if (!password || password !== process.env.EDITOR_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
    return res.status(400).json({ error: 'No instruction provided' });
  }
  if (instruction.length > 2000) {
    return res.status(400).json({ error: 'Instruction too long (max 2000 characters)' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured. Missing environment variables.' });
  }

  try {
    // Step 1: Fetch index.html from GitHub
    console.log('[edit] Fetching from GitHub...');
    const t0 = Date.now();

    const ghFileRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/index.html`,
      {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );

    if (!ghFileRes.ok) {
      const err = await ghFileRes.text();
      console.error('[edit] GitHub fetch error:', ghFileRes.status, err.substring(0, 200));
      return res.status(502).json({ error: 'Could not fetch deck from GitHub.' });
    }

    const ghFile = await ghFileRes.json();
    const fullHtml = Buffer.from(ghFile.content, 'base64').toString('utf-8');
    const fileSha = ghFile.sha;
    console.log(`[edit] GitHub fetch: ${Date.now() - t0}ms, file size: ${fullHtml.length}`);

    // Step 2: Strip base64 images (768KB → ~34KB)
    const placeholders = [];
    const strippedHtml = fullHtml.replace(
      /src="(data:image\/[^"]+)"/g,
      (fullMatch, dataUri) => {
        const idx = placeholders.length;
        const placeholder = `__IMG_${idx}__`;
        placeholders.push({ placeholder, dataUri });
        return `src="${placeholder}"`;
      }
    );
    console.log(`[edit] Stripped to ${strippedHtml.length} chars, ${placeholders.length} images removed`);

    // Step 3: Call Claude API — ask for SEARCH/REPLACE pairs only (not full HTML)
    const t1 = Date.now();
    const systemPrompt = `You are an HTML editor for a pitch deck. You receive the full HTML and a change instruction. You must return ONLY a JSON array of search-and-replace operations.

RESPONSE FORMAT — return ONLY valid JSON, no markdown fences, no explanation:
[
  {"search": "exact old text", "replace": "exact new text"}
]

RULES:
1. Each "search" string must be an EXACT substring of the HTML that uniquely identifies the text to change. Include enough surrounding context to be unique.
2. Each "replace" string is what replaces it.
3. Make ONLY the changes requested. Do not fix other issues or make unrequested modifications.
4. Slides are marked with comments: <!-- 1. TITLE -->, <!-- 2. JOSH -->, <!-- 3. ZACH -->, <!-- 4. PROBLEM -->, <!-- 5. SOLUTION -->, <!-- 6. MARKET -->, <!-- 7. LOCATION -->, <!-- 8. MEMBER EXPERIENCE -->, <!-- 9. PROOF -->, <!-- 10. REVENUE -->, <!-- 11. MEMBERSHIP -->, <!-- 12. FINANCIAL -->, <!-- 13. THE DEAL -->, <!-- 14. FUNDS -->, <!-- 15. TAX -->, <!-- 16. WHY -->, <!-- 17. TIMELINE -->, <!-- 18. CLOSE -->
5. Image sources show as __IMG_0__, __IMG_1__ etc. NEVER include these in search or replace strings.
6. If the instruction is unclear, return: [{"error": "explanation of what was unclear"}]
7. For text changes, include the HTML tags around the text in your search string to ensure uniqueness.
8. Return an empty array [] if no changes are needed.`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Here is the current HTML:\n\n${strippedHtml}\n\n---\n\nInstruction: ${instruction.trim()}`
        }]
      })
    });

    console.log(`[edit] Claude API: ${Date.now() - t1}ms, status: ${anthropicRes.status}`);

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error('[edit] Anthropic error:', err.substring(0, 300));
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const anthropicData = await anthropicRes.json();
    let responseText = (anthropicData.content?.[0]?.text || '').trim();

    // Strip markdown code fences if Claude wrapped the response
    if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    console.log(`[edit] Claude response: ${responseText.substring(0, 200)}`);

    // Step 4: Parse the JSON response
    let changes;
    try {
      changes = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[edit] JSON parse error:', parseErr.message, 'Response:', responseText.substring(0, 500));
      return res.status(422).json({ error: 'AI returned an invalid response. Please try rephrasing your request.' });
    }

    // Check for error response from Claude
    if (changes.length === 1 && changes[0].error) {
      return res.status(422).json({ error: changes[0].error });
    }

    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(422).json({ error: 'No changes were identified. Try being more specific.' });
    }

    // Step 5: Apply changes to the full HTML (with images intact)
    let editedHtml = fullHtml;
    const applied = [];
    const failed = [];

    for (const change of changes) {
      if (!change.search || typeof change.search !== 'string') continue;
      if (typeof change.replace !== 'string') continue;

      if (editedHtml.includes(change.search)) {
        editedHtml = editedHtml.replace(change.search, change.replace);
        applied.push(change.search.substring(0, 50));
      } else {
        failed.push(change.search.substring(0, 50));
      }
    }

    console.log(`[edit] Applied: ${applied.length}, Failed: ${failed.length}`);

    if (applied.length === 0) {
      return res.status(422).json({
        error: 'Could not find the text to change. The AI may have matched incorrectly. Try rephrasing.'
      });
    }

    // Step 6: Validate the HTML still has basic structure
    if (!editedHtml.includes('<!DOCTYPE html>') && !editedHtml.includes('<!doctype html>')) {
      return res.status(500).json({ error: 'Edit resulted in invalid HTML. Please try again.' });
    }

    // Step 7: Commit to GitHub
    const t2 = Date.now();
    const commitMsg = `fix: ${instruction.trim().substring(0, 72)}`;
    const updateRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/index.html`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: commitMsg,
          content: Buffer.from(editedHtml).toString('base64'),
          sha: fileSha
        })
      }
    );

    console.log(`[edit] GitHub push: ${Date.now() - t2}ms, status: ${updateRes.status}`);

    if (!updateRes.ok) {
      const err = await updateRes.text();
      console.error('[edit] GitHub update error:', err.substring(0, 200));
      if (updateRes.status === 409) {
        return res.status(409).json({ error: 'Another edit was just made. Wait a few seconds and try again.' });
      }
      return res.status(502).json({ error: 'Could not save to GitHub. Please try again.' });
    }

    const updateData = await updateRes.json();
    const commitUrl = updateData.commit?.html_url || '';

    console.log(`[edit] Total: ${Date.now() - t0}ms`);

    return res.status(200).json({
      success: true,
      commitUrl,
      message: `Change applied (${applied.length} edit${applied.length > 1 ? 's' : ''}). Live in ~30 seconds.`,
      applied: applied.length,
      warnings: failed.length > 0 ? `${failed.length} change(s) could not be matched.` : undefined
    });

  } catch (err) {
    console.error('[edit] Unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
