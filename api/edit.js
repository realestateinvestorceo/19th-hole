export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password, instruction } = req.body || {};

  // Password check
  if (!password || password !== process.env.EDITOR_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Input validation
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
      console.error('GitHub fetch error:', err);
      return res.status(502).json({ error: 'Could not fetch deck from GitHub.' });
    }

    const ghFile = await ghFileRes.json();
    const fullHtml = Buffer.from(ghFile.content, 'base64').toString('utf-8');
    const fileSha = ghFile.sha;

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

    // Step 3: Call Claude API
    const systemPrompt = `You are an HTML editor for a pitch deck. You will receive the FULL HTML source of a single-page presentation and a change instruction from the deck owner.

RULES:
1. Return ONLY the complete modified HTML. No explanations, no markdown code fences, no commentary.
2. Make ONLY the change requested. Do not fix other issues, improve formatting, optimize code, or make any unrequested modifications.
3. Slides are marked with HTML comments: <!-- 1. TITLE -->, <!-- 2. JOSH -->, <!-- 3. ZACH -->, <!-- 4. PROBLEM -->, <!-- 5. SOLUTION -->, <!-- 6. MARKET -->, <!-- 7. LOCATION -->, <!-- 8. MEMBER EXPERIENCE -->, <!-- 9. PROOF -->, <!-- 10. REVENUE -->, <!-- 11. MEMBERSHIP -->, <!-- 12. FINANCIAL -->, <!-- 13. THE DEAL -->, <!-- 14. FUNDS -->, <!-- 15. TAX -->, <!-- 16. WHY -->, <!-- 17. TIMELINE -->, <!-- 18. CLOSE -->
4. Preserve ALL existing formatting, whitespace, and structure exactly as-is except for the specific requested change.
5. Image sources contain placeholder strings like __IMG_0__, __IMG_1__. Do NOT modify these placeholders in any way.
6. If the instruction is unclear or you cannot determine what change to make, return the original HTML unchanged and prepend the string ERROR: followed by a brief explanation on the very first line, before the <!DOCTYPE>.
7. Do not add or remove HTML comments, do not reformat the code, do not change class names or CSS unless specifically asked.`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Here is the current HTML:\n\n${strippedHtml}\n\n---\n\nInstruction: ${instruction.trim()}`
        }]
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const anthropicData = await anthropicRes.json();
    let editedHtml = anthropicData.content?.[0]?.text || '';

    // Step 4: Check for Claude errors
    if (editedHtml.startsWith('ERROR:')) {
      const errorMsg = editedHtml.split('\n')[0].replace('ERROR:', '').trim();
      return res.status(422).json({ error: errorMsg });
    }

    // Step 5: Restore base64 images
    for (const { placeholder, dataUri } of placeholders) {
      editedHtml = editedHtml.replace(`src="${placeholder}"`, `src="${dataUri}"`);
    }

    // Step 6: Validate output
    if (!editedHtml.includes('<!DOCTYPE html>') && !editedHtml.includes('<!doctype html>')) {
      return res.status(500).json({ error: 'AI returned invalid HTML. Please try again with a clearer instruction.' });
    }
    // Check no leftover placeholders
    if (/__IMG_\d+__/.test(editedHtml)) {
      return res.status(500).json({ error: 'AI corrupted an image placeholder. Please try again.' });
    }

    // Step 7: Commit to GitHub
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

    if (!updateRes.ok) {
      const err = await updateRes.text();
      console.error('GitHub update error:', err);
      if (updateRes.status === 409) {
        return res.status(409).json({ error: 'Another edit was just made. Wait a few seconds and try again.' });
      }
      return res.status(502).json({ error: 'Could not save to GitHub. Please try again.' });
    }

    const updateData = await updateRes.json();
    const commitUrl = updateData.commit?.html_url || '';

    return res.status(200).json({
      success: true,
      commitUrl,
      message: 'Change committed. Live in ~30 seconds.'
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
