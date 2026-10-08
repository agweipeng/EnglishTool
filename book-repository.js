/* Catalog and chapter loading, shared by the browser and tests. */
(function (root) {
  'use strict';
  function create({ catalog, loadJSON }) {
    const books = catalog?.books || [];
    const cache = new Map();
    const idOK = id => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
    const versionOK = version => typeof version === 'string' && /^[a-f0-9]{16}$/.test(version);
    if (catalog?.schemaVersion !== 1 || !Array.isArray(books)
      || books.some(b => !idOK(b?.id) || b.manifestPath !== `books/${b.id}/manifest.json`)
      || new Set(books.map(b => b.id)).size !== books.length) throw new Error('Invalid book catalog');
    const metadata = id => books.find(book => book.id === id);
    function cached(path, validate) {
      if (!cache.has(path)) {
        const pending = Promise.resolve().then(() => loadJSON(path)).then(data => {
          if (!validate(data)) throw new Error(`Invalid book resource: ${path}`);
          return data;
        }).catch(error => {
          // A repaired package must not reuse an older manifest or local script.
          const prefix = path.split('/').slice(0, 2).join('/') + '/';
          for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
          loadJSON.invalidate?.(path);
          throw error;
        });
        cache.set(path, pending);
      }
      return cache.get(path);
    }
    async function getBook(id) {
      const book = metadata(id);
      if (!book) throw new Error('This book is not in the bookshelf');
      return cached(book.manifestPath, manifest => manifest?.schemaVersion === 1 && manifest.id === id
        && typeof manifest.title === 'string' && manifest.title.trim().length > 0
        && typeof manifest.author === 'string' && typeof manifest.introduction === 'string'
        && ['chapter', 'story'].includes(manifest.sectionType) && versionOK(manifest.version)
        && Array.isArray(manifest.chapters) && manifest.chapters.length === book.sectionCount && manifest.chapters.length > 0
        && new Set(manifest.chapters.map(c => c.id)).size === manifest.chapters.length
        && manifest.chapters.every(c => idOK(c?.id) && c.path === `books/${id}/chapters/${c.id}.json`
          && typeof c.title === 'string' && Number.isInteger(c.number) && c.number > 0
          && Number.isInteger(c.wordCount) && c.wordCount >= 0 && versionOK(c.version)));
    }
    async function getChapter(bookId, chapterId) {
      const book = await getBook(bookId);
      const chapter = book.chapters.find(chapter => chapter.id === chapterId);
      if (!chapter) throw new Error('This chapter is not in the book');
      return cached(chapter.path, data => data?.id === chapter.id && data.version === chapter.version
        && typeof data.text === 'string' && data.text.trim().length > 0 && data.text.length <= 200000);
    }
    return { listBooks: () => books, getBook, getChapter };
  }
  function browserLoader() {
    const packages = new Map();
    const loadJSON = async path => {
      if (root.location.protocol !== 'file:') {
        const response = await fetch(path, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Could not load book (${response.status})`);
        return response.json();
      }
      const id = path.split('/')[1];
      if (!packages.has(id)) {
        packages.set(id, new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = `books/${id}/file-data.js`;
          script.onload = () => { script.remove(); resolve(); };
          script.onerror = () => { script.remove(); packages.delete(id); reject(new Error('Could not load the local book package')); };
          document.head.appendChild(script);
        }));
      }
      await packages.get(id);
      if (!Object.prototype.hasOwnProperty.call(root.BookResources || {}, path)) throw new Error('Missing local book resource');
      return root.BookResources[path];
    };
    loadJSON.invalidate = path => {
      const id = path.split('/')[1];
      packages.delete(id);
      const prefix = `books/${id}/`;
      for (const key of Object.keys(root.BookResources || {})) {
        if (key.startsWith(prefix)) delete root.BookResources[key];
      }
    };
    return loadJSON;
  }
  const api = { create, browserLoader };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BookRepository = create({ catalog: root.BookCatalog, loadJSON: browserLoader() });
})(typeof window !== 'undefined' ? window : globalThis);
