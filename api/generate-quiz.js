export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Please use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error: GEMINI_API_KEY is missing.' });
  }

  try {
    const { words } = req.body || {};

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ error: 'Invalid request body: "words" must be a non-empty array.' });
    }

    const wordListPrompt = words
      .map((item, idx) => {
        const wordStr = typeof item === 'string' ? item : item.word;
        const prev = Array.isArray(item?.previousSentences) ? item.previousSentences : [];
        const prevText =
          prev.length > 0
            ? `\n   - 歷史已出過例句（嚴禁重複相同句型結構、相同主詞或相同領域情境）：\n     ${prev.map((s, i) => `(${i + 1}) ${s}`).join('\n     ')}`
            : '\n   - 歷史已出過例句：無';
        return `${idx + 1}. 單字：${wordStr}${prevText}`;
      })
      .join('\n');

    const systemInstruction = `你是一位專業的台灣英文命題專家，熟悉台灣學測（GSAT）、指考（AST）以及全民英檢（GEPT）中高級程度。
請根據使用者提供的英文單字清單，為每個單字設計一道高品質的克漏字測驗題目，並嚴格遵守以下規則：

1. **難度與程度**：針對台灣學測、指考與 GEPT 中高級程度出題，用字自然道地。
2. **強制防重複機制**：若該單字有提供「歷史已出過例句」，**嚴禁**使用相同的句型結構、相同主詞或相同領域情境！必須在「商業財經、環境科學、歷史文化、科技趨勢、日常生活、醫療健康、教育心理」等不同領域之間輪換。
3. **例句長度與挖空**：造出 12～22 個英文單字的自然例句，將目標單字（或其正確的時態、單複數、詞形變化）挖空並以 \`_______\`（7個底線）表示。
4. **干擾選項（distractors）**：生成 3 個干擾選項，必須與正確答案（\`answerInSentence\`）的**詞性與文法型態完全相同**（例如：若正解為過去分詞，干擾項也必須是過去分詞；若為複數名詞，干擾項也必須是複數名詞），且具備語意干擾性，避免讓學生靠詞性或文法線索猜題。
5. **輸出格式**：必須回傳純 JSON 陣列（Array），每個物件包含以下欄位：
   - \`word\`: string（小寫原形單字）
   - \`pos\`: string（詞性縮寫，例如 "n.", "v.", "adj.", "adv."）
   - \`meaning\`: string（精準繁體中文釋義）
   - \`clozeSentence\`: string（包含 _______ 的英文挖空例句）
   - \`fullSentence\`: string（完整英文例句）
   - \`sentenceTranslation\`: string（整句繁體中文翻譯）
   - \`answerInSentence\`: string（空格中實際填入的單字形式）
   - \`distractors\`: Array<{ word: string, meaning: string }>（長度必須為 3，每個物件包含該干擾字的英文單字與繁體中文釋義）`;

    const userPrompt = `請為以下單字生成測驗題庫（回傳 JSON 陣列）：\n\n${wordListPrompt}`;

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    let geminiResponse = null;
    let errText = '';

    for (const model of models) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      geminiResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.85,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (geminiResponse.ok) {
        break;
      }

      errText = await geminiResponse.text();
      if (geminiResponse.status !== 404) {
        break;
      }
    }

    if (!geminiResponse || !geminiResponse.ok) {
      console.error('Gemini API error:', geminiResponse?.status, errText);
      let detailMsg = '';
      try {
        const parsedErr = JSON.parse(errText);
        detailMsg = parsedErr?.error?.message || '';
      } catch {
        detailMsg = errText;
      }
      return res.status(geminiResponse?.status || 500).json({
        error: `Gemini API failed with status ${geminiResponse?.status}${detailMsg ? `: ${detailMsg}` : ''}`,
        details: errText,
      });
    }

    const data = await geminiResponse.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      return res.status(502).json({ error: 'Empty response from Gemini API.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('Failed to parse Gemini JSON:', rawText);
      return res.status(502).json({ error: 'Invalid JSON returned from Gemini API.' });
    }

    if (!Array.isArray(parsed)) {
      return res.status(502).json({ error: 'Expected a JSON array from Gemini API.' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Serverless function error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}
