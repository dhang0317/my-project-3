import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BookOpen,
  PlusCircle,
  Database,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Download,
  Upload,
  Trash2,
  Sparkles,
  ArrowRight,
  Loader2,
  Layers,
  KeyRound,
  Eye,
  EyeOff,
} from 'lucide-react';
import { generateQuizFromGemini } from './utils/gemini';

const STORAGE_KEY = 'vocab_trainer_v1_data';
const API_KEY_STORAGE_KEY = 'vocab_trainer_gemini_api_key';

// Fisher-Yates 洗牌演算法
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 讀取 localStorage
function loadVocabData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [vocabList, setVocabList] = useState(() => loadVocabData());
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE_KEY) || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [activeTab, setActiveTab] = useState('quiz'); // 'quiz' | 'import' | 'manage'

  // 刷題狀態
  const [selectedTag, setSelectedTag] = useState('ALL');
  const [quizMode, setQuizMode] = useState('cloze'); // 'cloze' | 'meaning'
  const [currentWordId, setCurrentWordId] = useState(null);
  const [options, setOptions] = useState([]);
  const [selectedOptionIdx, setSelectedOptionIdx] = useState(null);
  const [isRefreshingSentence, setIsRefreshingSentence] = useState(false);
  const [quizError, setQuizError] = useState('');

  // 匯入狀態
  const [importTag, setImportTag] = useState('預設字庫');
  const [importText, setImportText] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState('');

  // 備份還原 input ref
  const fileInputRef = useRef(null);
  const [manageMessage, setManageMessage] = useState('');

  // 同步寫入 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(vocabList));
    } catch (err) {
      console.error('Failed to save to localStorage:', err);
    }
  }, [vocabList]);

  useEffect(() => {
    try {
      localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    } catch (err) {
      console.error('Failed to save API key to localStorage:', err);
    }
  }, [apiKey]);

  // 統計數據
  const totalCount = vocabList.length;
  const masteredCount = useMemo(
    () => vocabList.filter((item) => (item.streak || 0) >= 2).length,
    [vocabList]
  );

  // 所有標籤
  const allTags = useMemo(() => {
    const tags = new Set();
    vocabList.forEach((item) => {
      if (item.tag) tags.add(item.tag);
    });
    return Array.from(tags);
  }, [vocabList]);

  // 篩選後的字庫
  const filteredVocab = useMemo(() => {
    if (selectedTag === 'ALL') return vocabList;
    return vocabList.filter((item) => item.tag === selectedTag);
  }, [vocabList, selectedTag]);

  // 建立選項（Fisher-Yates 洗牌）
  const buildOptionsForWord = useCallback(
    (wordObj, mode, pool) => {
      if (!wordObj || !wordObj.currentQuestion) return [];
      const q = wordObj.currentQuestion;

      if (mode === 'cloze') {
        const correctOpt = {
          label: q.answerInSentence || q.word,
          subLabel: q.meaning,
          isCorrect: true,
        };
        const distractorOpts = (q.distractors || []).slice(0, 3).map((d) => ({
          label: d.word,
          subLabel: d.meaning,
          isCorrect: false,
        }));
        return shuffleArray([correctOpt, ...distractorOpts]);
      } else {
        // meaning 模式：優先從同字庫（pool）抽取其他單字釋義，不足 4 個時用該字的 distractors 中文補齊
        const correctOpt = {
          label: q.meaning,
          subLabel: q.word,
          isCorrect: true,
        };

        const otherPoolItems = shuffleArray(
          pool.filter((item) => item.word !== wordObj.word && item.currentQuestion?.meaning)
        );

        const distractorOpts = [];
        const usedMeanings = new Set([q.meaning]);

        for (const item of otherPoolItems) {
          if (distractorOpts.length >= 3) break;
          const m = item.currentQuestion.meaning;
          if (!usedMeanings.has(m)) {
            usedMeanings.add(m);
            distractorOpts.push({
              label: m,
              subLabel: item.word,
              isCorrect: false,
            });
          }
        }

        // 不足 3 個干擾項時，用該字本身的 distractors 中文補齊
        if (distractorOpts.length < 3 && Array.isArray(q.distractors)) {
          for (const d of q.distractors) {
            if (distractorOpts.length >= 3) break;
            if (d.meaning && !usedMeanings.has(d.meaning)) {
              usedMeanings.add(d.meaning);
              distractorOpts.push({
                label: d.meaning,
                subLabel: d.word,
                isCorrect: false,
              });
            }
          }
        }

        return shuffleArray([correctOpt, ...distractorOpts]);
      }
    },
    []
  );

  // 加權抽選下一題
  const pickNextQuestion = useCallback(
    (pool, avoidWordId = null, mode = quizMode) => {
      if (!pool || pool.length === 0) {
        setCurrentWordId(null);
        setOptions([]);
        setSelectedOptionIdx(null);
        return;
      }

      let candidates = pool;
      if (pool.length > 1 && avoidWordId) {
        candidates = pool.filter((item) => item.word !== avoidWordId);
      }

      // 建立加權池：未掌握 (streak < 2) 權重 5 + wrongCount * 3，已掌握 (streak >= 2) 權重 1
      const weightedPool = [];
      candidates.forEach((item) => {
        const streak = item.streak || 0;
        const wrongCount = item.wrongCount || 0;
        const weight = streak < 2 ? 5 + wrongCount * 3 : 1;
        for (let i = 0; i < weight; i++) {
          weightedPool.push(item);
        }
      });

      const chosen =
        weightedPool[Math.floor(Math.random() * weightedPool.length)] || candidates[0];

      setCurrentWordId(chosen.word);
      setOptions(buildOptionsForWord(chosen, mode, pool));
      setSelectedOptionIdx(null);
      setQuizError('');
    },
    [buildOptionsForWord, quizMode]
  );

  // 當切換分頁到 quiz、篩選標籤或模式改變時，若無當前題目或當前題目不在篩選池中，重新抽題
  useEffect(() => {
    if (activeTab !== 'quiz') return;
    if (filteredVocab.length === 0) {
      setCurrentWordId(null);
      setOptions([]);
      setSelectedOptionIdx(null);
      return;
    }

    const existsInPool = filteredVocab.some((item) => item.word === currentWordId);
    if (!currentWordId || !existsInPool) {
      pickNextQuestion(filteredVocab, null, quizMode);
    } else {
      // 模式切換時重建選項
      const currentObj = filteredVocab.find((item) => item.word === currentWordId);
      if (currentObj && selectedOptionIdx === null) {
        setOptions(buildOptionsForWord(currentObj, quizMode, filteredVocab));
      }
    }
  }, [activeTab, filteredVocab, quizMode, currentWordId, selectedOptionIdx, pickNextQuestion, buildOptionsForWord]);

  const currentWordObj = useMemo(
    () => filteredVocab.find((item) => item.word === currentWordId) || null,
    [filteredVocab, currentWordId]
  );

  // 背景非同步為答錯單字生成全新例句
  const regenerateWordInBackground = useCallback(async (wordObj) => {
    if (!apiKey.trim()) return;
    try {
      const data = await generateQuizFromGemini(
        [
          {
            word: wordObj.word,
            previousSentences: wordObj.previousSentences || [],
          },
        ],
        apiKey
      );
      if (!Array.isArray(data) || data.length === 0) return;

      const newQ = data[0];
      setVocabList((prev) =>
        prev.map((item) => {
          if (item.word !== wordObj.word) return item;
          const prevSentences = item.previousSentences || [];
          const updatedSentences =
            newQ.fullSentence && !prevSentences.includes(newQ.fullSentence)
              ? [...prevSentences, newQ.fullSentence]
              : prevSentences;
          return {
            ...item,
            currentQuestion: newQ,
            previousSentences: updatedSentences,
          };
        })
      );
    } catch (err) {
      console.error('Background regeneration failed:', err);
    }
  }, [apiKey]);

  // 作答處理
  const handleSelectOption = (idx) => {
    if (selectedOptionIdx !== null || !currentWordObj) return;
    setSelectedOptionIdx(idx);

    const chosenOpt = options[idx];
    const isCorrect = Boolean(chosenOpt?.isCorrect);

    setVocabList((prev) =>
      prev.map((item) => {
        if (item.word !== currentWordObj.word) return item;
        if (isCorrect) {
          return {
            ...item,
            streak: (item.streak || 0) + 1,
          };
        } else {
          return {
            ...item,
            streak: 0,
            wrongCount: (item.wrongCount || 0) + 1,
          };
        }
      })
    );

    if (!isCorrect) {
      // 答錯時在背景非同步生成全新領域與句型的題目
      regenerateWordInBackground(currentWordObj);
    }
  };

  // 手動點擊「換全新例句情境」
  const handleRefreshSentence = async () => {
    if (!currentWordObj || isRefreshingSentence) return;
    setIsRefreshingSentence(true);
    setQuizError('');
    try {
      const data = await generateQuizFromGemini(
        [
          {
            word: currentWordObj.word,
            previousSentences: currentWordObj.previousSentences || [],
          },
        ],
        apiKey
      );
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('回傳題目格式不正確');
      }

      const newQ = data[0];
      const updatedWordObj = {
        ...currentWordObj,
        currentQuestion: newQ,
        previousSentences:
          newQ.fullSentence && !(currentWordObj.previousSentences || []).includes(newQ.fullSentence)
            ? [...(currentWordObj.previousSentences || []), newQ.fullSentence]
            : currentWordObj.previousSentences || [],
      };

      setVocabList((prev) =>
        prev.map((item) => (item.word === currentWordObj.word ? updatedWordObj : item))
      );
      setOptions(buildOptionsForWord(updatedWordObj, quizMode, filteredVocab));
      setSelectedOptionIdx(null);
    } catch (err) {
      setQuizError(err.message || '更新例句失敗，請稍後再試');
    } finally {
      setIsRefreshingSentence(false);
    }
  };

  // 匯入單字並生成題庫
  const handleImportSubmit = async (e) => {
    e.preventDefault();
    setImportError('');

    const rawWords = importText
      .split(/[\n,，]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 0 && /^[a-z-]+$/i.test(w));

    const uniqueWords = Array.from(new Set(rawWords));
    if (uniqueWords.length === 0) {
      setImportError('請輸入至少一個有效的英文單字（支援換行或逗號分隔）。');
      return;
    }

    const tagToUse = importTag.trim() || '預設字庫';
    setIsImporting(true);

    try {
      const payloadWords = uniqueWords.map((w) => {
        const existing = vocabList.find((item) => item.word === w);
        return {
          word: w,
          previousSentences: existing?.previousSentences || [],
        };
      });

      const generatedList = await generateQuizFromGemini(payloadWords, apiKey);

      setVocabList((prev) => {
        const map = new Map(prev.map((item) => [item.word, item]));

        generatedList.forEach((q) => {
          const w = (q.word || '').toLowerCase().trim();
          if (!w) return;
          const existing = map.get(w);
          const prevSentences = existing?.previousSentences || [];
          const newSentences =
            q.fullSentence && !prevSentences.includes(q.fullSentence)
              ? [...prevSentences, q.fullSentence]
              : prevSentences;

          map.set(w, {
            word: w,
            tag: tagToUse,
            streak: existing?.streak || 0,
            wrongCount: existing?.wrongCount || 0,
            previousSentences: newSentences,
            currentQuestion: q,
          });
        });

        return Array.from(map.values());
      });

      setImportText('');
      setSelectedTag(tagToUse);
      setActiveTab('quiz');
    } catch (err) {
      setImportError(err.message || '生成題庫時發生錯誤，請檢查網路或 API 金鑰設定。');
    } finally {
      setIsImporting(false);
    }
  };

  // 匯出 JSON 備份
  const handleExportBackup = () => {
    const dataStr = JSON.stringify(vocabList, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `vocab-flow-backup-${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setManageMessage('已匯出 JSON 備份檔。');
  };

  // 匯入 JSON 還原
  const handleImportBackup = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        if (!Array.isArray(parsed)) {
          throw new Error('備份檔格式不正確');
        }
        setVocabList(parsed);
        setManageMessage(`成功還原 ${parsed.length} 個單字！`);
      } catch (err) {
        setManageMessage(`匯入失敗：${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // 刪除單字
  const handleDeleteWord = (word) => {
    setVocabList((prev) => prev.filter((item) => item.word !== word));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* 頂部導覽列 */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xl shadow-sm">
              V
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-tight">VocabFlow AI</h1>
              <p className="text-xs font-medium text-slate-500">
                已掌握 <span className="text-indigo-600 font-bold">{masteredCount}</span> / {totalCount} 字
              </p>
            </div>
          </div>

          {/* 三個分頁切換 */}
          <nav className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('quiz')}
              className={`px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 transition-colors ${
                activeTab === 'quiz'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              開始刷題
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('import')}
              className={`px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 transition-colors ${
                activeTab === 'import'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <PlusCircle className="w-4 h-4" />
              + 匯入單字
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('manage')}
              className={`px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 transition-colors ${
                activeTab === 'manage'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Database className="w-4 h-4" />
              字庫與備份
            </button>
          </nav>
        </div>
      </header>

      {/* 主內容區 */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-6">
        {/* ================= 分頁一：開始刷題 ================= */}
        {activeTab === 'quiz' && (
          <div className="space-y-5">
            {/* 篩選與模式切換列 */}
            <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Layers className="w-4 h-4 text-slate-500" />
                <select
                  value={selectedTag}
                  onChange={(e) => setSelectedTag(e.target.value)}
                  className="bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="ALL">全部字庫 ({vocabList.length})</option>
                  {allTags.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag} ({vocabList.filter((v) => v.tag === tag).length})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex bg-slate-100 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => {
                    setQuizMode('cloze');
                    setSelectedOptionIdx(null);
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                    quizMode === 'cloze'
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  語境克漏字
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQuizMode('meaning');
                    setSelectedOptionIdx(null);
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                    quizMode === 'meaning'
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  核心字義速刷
                </button>
              </div>
            </div>

            {filteredVocab.length === 0 ? (
              <div className="bg-white rounded-3xl p-10 border border-slate-200 text-center space-y-4 shadow-sm">
                <p className="text-lg font-semibold text-slate-700">目前字庫尚無單字</p>
                <p className="text-sm text-slate-500">請先點擊上方「+ 匯入單字」建立你的專屬題庫。</p>
                <button
                  type="button"
                  onClick={() => setActiveTab('import')}
                  className="px-6 py-3.5 bg-indigo-600 text-white rounded-2xl font-semibold text-base hover:bg-indigo-700 active:scale-[0.99] transition"
                >
                  前往匯入單字
                </button>
              </div>
            ) : currentWordObj && currentWordObj.currentQuestion ? (
              <div className="bg-white rounded-3xl p-6 md:p-8 border border-slate-200 shadow-sm space-y-6">
                {/* 題目狀態與換句按鈕 */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-bold">
                      {currentWordObj.tag || '預設字庫'}
                    </span>
                    {(currentWordObj.streak || 0) >= 2 ? (
                      <span className="px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold">
                        已掌握
                      </span>
                    ) : (
                      <span className="px-3 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-bold">
                        連對 {currentWordObj.streak || 0} / 2
                      </span>
                    )}
                  </div>

                  {quizMode === 'cloze' && (
                    <button
                      type="button"
                      onClick={handleRefreshSentence}
                      disabled={isRefreshingSentence}
                      className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold flex items-center gap-2 transition disabled:opacity-50"
                    >
                      {isRefreshingSentence ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      換全新例句情境
                    </button>
                  )}
                </div>

                {quizError && (
                  <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm font-medium">
                    {quizError}
                  </div>
                )}

                {/* 題幹區 */}
                <div className="py-4">
                  {quizMode === 'cloze' ? (
                    <p className="text-xl md:text-2xl font-medium text-slate-800 leading-relaxed">
                      {currentWordObj.currentQuestion.clozeSentence}
                    </p>
                  ) : (
                    <div className="text-center py-4 space-y-2">
                      <p className="text-3xl md:text-4xl font-bold text-slate-900 tracking-wide">
                        {currentWordObj.word}
                      </p>
                      <p className="text-sm font-semibold text-indigo-600">
                        {currentWordObj.currentQuestion.pos}
                      </p>
                    </div>
                  )}
                </div>

                {/* 四選一寬版大按鈕 */}
                <div className="grid grid-cols-1 gap-3.5">
                  {options.map((opt, idx) => {
                    const isAnswered = selectedOptionIdx !== null;
                    const isSelected = selectedOptionIdx === idx;
                    const isCorrect = opt.isCorrect;

                    let btnStyle =
                      'bg-slate-50 border-slate-200 text-slate-800 hover:bg-indigo-50/60 hover:border-indigo-300';
                    if (isAnswered) {
                      if (isCorrect) {
                        btnStyle = 'bg-emerald-50 border-emerald-500 text-emerald-900 ring-2 ring-emerald-200';
                      } else if (isSelected && !isCorrect) {
                        btnStyle = 'bg-rose-50 border-rose-500 text-rose-900 ring-2 ring-rose-200';
                      } else {
                        btnStyle = 'bg-slate-50 border-slate-200 text-slate-400 opacity-75';
                      }
                    }

                    return (
                      <button
                        key={idx}
                        type="button"
                        disabled={isAnswered}
                        onClick={() => handleSelectOption(idx)}
                        className={`w-full text-left px-5 py-4 md:py-5 rounded-2xl border-2 transition-all flex items-center justify-between gap-4 active:scale-[0.99] ${btnStyle}`}
                      >
                        <div className="flex items-center gap-3.5">
                          <span className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-sm font-bold text-slate-600 shrink-0">
                            {String.fromCharCode(65 + idx)}
                          </span>
                          <span className="text-lg md:text-xl font-semibold">{opt.label}</span>
                        </div>

                        {isAnswered && (
                          <div className="flex items-center gap-2 text-right">
                            <span className="text-sm font-medium opacity-90">{opt.subLabel}</span>
                            {isCorrect && <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />}
                            {isSelected && !isCorrect && (
                              <XCircle className="w-5 h-5 text-rose-600 shrink-0" />
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* 作答回饋與下一題大按鈕 */}
                {selectedOptionIdx !== null && (
                  <div className="pt-4 border-t border-slate-200 space-y-5 animate-fadeIn">
                    <div className="bg-slate-50 rounded-2xl p-5 space-y-2.5 border border-slate-200">
                      <div className="flex items-baseline gap-2.5 flex-wrap">
                        <span className="text-xl font-bold text-indigo-700">
                          {currentWordObj.word}
                        </span>
                        <span className="text-sm font-semibold text-slate-500">
                          {currentWordObj.currentQuestion.pos}
                        </span>
                        <span className="text-base font-semibold text-slate-800">
                          {currentWordObj.currentQuestion.meaning}
                        </span>
                      </div>
                      <p className="text-base text-slate-700 leading-relaxed">
                        {currentWordObj.currentQuestion.fullSentence}
                      </p>
                      <p className="text-sm text-slate-500 leading-relaxed">
                        {currentWordObj.currentQuestion.sentenceTranslation}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => pickNextQuestion(filteredVocab, currentWordObj.word, quizMode)}
                      className="w-full py-4 md:py-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold text-lg shadow-sm flex items-center justify-center gap-2 active:scale-[0.99] transition"
                    >
                      下一題
                      <ArrowRight className="w-5 h-5" />
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {/* ================= 分頁二：+ 匯入單字 ================= */}
        {activeTab === 'import' && (
          <form
            onSubmit={handleImportSubmit}
            className="bg-white rounded-3xl p-6 md:p-8 border border-slate-200 shadow-sm space-y-6"
          >
            <div>
              <h2 className="text-xl font-bold text-slate-900">匯入英文單字並生成 AI 題庫</h2>
              <p className="text-sm text-slate-500 mt-1">
                系統將針對台灣學測、指考與 GEPT 中高級程度，自動生成防重複例句與同詞性干擾選項。
              </p>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                <KeyRound className="w-4 h-4 text-indigo-600" />
                Gemini API Key（僅儲存於本機瀏覽器）
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="請貼上您的 Gemini API Key (AIza...)"
                  className="w-full pl-4 pr-12 py-3.5 rounded-2xl border border-slate-300 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-slate-500 hover:text-slate-700"
                  aria-label={showApiKey ? '隱藏 API Key' : '顯示 API Key'}
                >
                  {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-bold text-slate-700">字庫分類標籤</label>
              <input
                type="text"
                value={importTag}
                onChange={(e) => setImportTag(e.target.value)}
                placeholder="例如：學測高頻7000、商業英文"
                className="w-full px-4 py-3.5 rounded-2xl border border-slate-300 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-bold text-slate-700">
                輸入英文單字（支援換行或逗號分隔）
              </label>
              <textarea
                rows={6}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'abundant\nresilient, sustainable\nallocate'}
                className="w-full px-4 py-3.5 rounded-2xl border border-slate-300 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {importError && (
              <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-sm font-medium">
                {importError}
              </div>
            )}

            <button
              type="submit"
              disabled={isImporting}
              className="w-full py-4 md:py-5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-2xl font-bold text-lg shadow-sm flex items-center justify-center gap-2.5 active:scale-[0.99] transition"
            >
              {isImporting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  AI 正在生成防重複題庫中...
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5" />
                  開始生成題庫
                </>
              )}
            </button>
          </form>
        )}

        {/* ================= 分頁三：字庫與備份 ================= */}
        {activeTab === 'manage' && (
          <div className="space-y-6">
            {/* 備份與還原卡片 */}
            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
              <h2 className="text-lg font-bold text-slate-900">資料備份與還原</h2>
              <p className="text-sm text-slate-500">
                所有字庫與學習進度皆儲存於本機瀏覽器，建議定期匯出 JSON 備份檔以免資料遺失。
              </p>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handleExportBackup}
                  className="px-5 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-semibold text-sm flex items-center gap-2 transition"
                >
                  <Download className="w-4 h-4" />
                  匯出備份檔（下載 .json）
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-5 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-2xl font-semibold text-sm flex items-center gap-2 transition"
                >
                  <Upload className="w-4 h-4" />
                  匯入還原（讀取 .json）
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleImportBackup}
                  className="hidden"
                />
              </div>

              {manageMessage && (
                <p className="text-sm font-semibold text-indigo-600">{manageMessage}</p>
              )}
            </div>

            {/* 字庫列表 */}
            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900">已收錄單字 ({vocabList.length})</h2>
              </div>

              {vocabList.length === 0 ? (
                <p className="text-sm text-slate-500 py-6 text-center">目前沒有任何單字。</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {vocabList.map((item) => {
                    const isMastered = (item.streak || 0) >= 2;
                    return (
                      <div
                        key={item.word}
                        className="py-4 flex items-center justify-between gap-4 flex-wrap"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="text-lg font-bold text-slate-900">{item.word}</span>
                            <span className="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold">
                              {item.tag || '預設字庫'}
                            </span>
                            {isMastered ? (
                              <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold">
                                已掌握
                              </span>
                            ) : (
                              <span className="px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-bold">
                                學習中
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-slate-700">
                            {item.currentQuestion?.pos} {item.currentQuestion?.meaning}
                          </p>
                          <p className="text-xs text-slate-400">
                            已累積 {(item.previousSentences || []).length} 種不同情境例句
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleDeleteWord(item.word)}
                          className="px-4 py-2.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 text-sm font-semibold flex items-center gap-1.5 transition"
                        >
                          <Trash2 className="w-4 h-4" />
                          刪除
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
