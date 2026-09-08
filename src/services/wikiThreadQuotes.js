const crypto = require('node:crypto');

const WIKI_THREAD_QUOTE_INSTRUCTIONS = [
  'This answer is displayed on a research memo paper. Write normal Markdown paragraphs directly on the paper.',
  'When answering from PDF body evidence, include the specific original sentence(s) that substantiate each main claim, in the flow of the answer.',
  'Encode each short verbatim excerpt exactly as <wiki-quote paper-id="EXACT_CATALOG_ID">original sentence</wiki-quote>. Use at most eight excerpts, each at most two sentences.',
  'Copy the original language and wording exactly from the supplied PDF body passages, even when your explanation is Korean. Never translate, paraphrase, invent or truncate an excerpt with ellipses.',
  'Use only a paper id from the supplied catalog. The application checks each excerpt and adds its title, PDF page, highlight and source connection.',
  'If no PDF body supports a claim, explain the limitation without inventing a quote. Do not wrap your whole answer in a quote or a code fence.',
].join(' ');

function canonical(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function extractWikiThreadQuotes(answer, papers, readingReport) {
  const quotes = [];
  const text = answer.replace(/<wiki-quote\s+paper-id="([^"]+)"\s*>([\s\S]*?)<\/wiki-quote>/g,
    (_tag, paperId, raw) => {
      const sentence = raw.trim();
      const paper = papers.find((item) => item.id === paperId);
      const key = canonical(sentence);
      // Keep unverified model output visibly unlinked; never invent source geometry.
      if (!paper || key.length < 12 || sentence.length > 2400 || quotes.length >= 8 || !canonical(paper.sourceText).includes(key)) {
        return `> ${sentence.replace(/\n/g, '\n> ')}`;
      }
      const passage = readingReport?.papers?.find((item) => item.id === paperId)?.passages
        ?.find((item) => canonical(item.excerpt).includes(key));
      const quote = { id: crypto.randomUUID(), paperId, title: paper.title, text: sentence,
        ...(passage?.pageStart ? { pageIndex: passage.pageStart - 1 } : {}) };
      quotes.push(quote);
      return `\n\n[[wiki-quote:${quote.id}]]\n\n`;
    });
  return { text, quotes };
}

module.exports = { WIKI_THREAD_QUOTE_INSTRUCTIONS, extractWikiThreadQuotes };
