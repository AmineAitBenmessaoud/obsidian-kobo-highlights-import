import { App, Modal, normalizePath, Notice } from "obsidian";
import { sanitize } from "sanitize-filename-ts";
import SqlJs from "sql.js";
import { binary } from "src/binaries/sql-wasm";
import { HighlightService } from "src/database/Highlight";
import { BookDetails, Bookmark } from "src/database/interfaces";
import { Repository } from "src/database/repository";
import { KoboHighlightsImporterSettings } from "src/settings/Settings";
import { OllamaService } from "src/services/OllamaService";
import { applyTemplateTransformations } from "src/template/template";
import { getTemplateContents } from "src/template/templateContents";

export class ExtractHighlightsModal extends Modal {
	goButtonEl!: HTMLButtonElement;
	inputFileEl!: HTMLInputElement;

	settings: KoboHighlightsImporterSettings;

	fileBuffer: ArrayBuffer | null | undefined;

	nrOfBooksExtracted: number;

	constructor(app: App, settings: KoboHighlightsImporterSettings) {
		super(app);
		this.settings = settings;
		this.nrOfBooksExtracted = 0;
	}

	private async fetchHighlights() {
		if (!this.fileBuffer) {
			throw new Error("No sqlite DB file selected...");
		}

		const SQLEngine = await SqlJs({
			wasmBinary: binary.buffer,
		});

		const db = new SQLEngine.Database(new Uint8Array(this.fileBuffer));

		const service: HighlightService = new HighlightService(
			new Repository(db),
		);

		const content = service.convertToMap(
			await service.getAllHighlight(this.settings.sortByChapterProgress),
		);

		const allBooksContent = new Map<string, Map<string, Bookmark[]>>();

		// Add all books with highlights
		for (const [bookTitle, chapters] of content) {
			allBooksContent.set(bookTitle, chapters);
		}

		if (this.settings.importAllBooks) {
			const allBooks = await service.getAllBooks();

			for (const bookTitle of allBooks.keys()) {
				if (!allBooksContent.has(bookTitle)) {
					allBooksContent.set(
						bookTitle,
						service.createEmptyContentMap(),
					);
				}
			}
		}

		this.nrOfBooksExtracted = allBooksContent.size;
		await this.writeBooks(service, allBooksContent);
	}

	private async writeBooks(
		service: HighlightService,
		content: Map<string, Map<string, Bookmark[]>>,
	) {
		console.log(`\n========== PROCESSING ${content.size} BOOK(S) SEPARATELY ==========`);
		for (const [bookTitle] of content) {
			console.log(`📚 Book: ${bookTitle}`);
		}
		console.log(`==================================================\n`);

		const template = await getTemplateContents(
			this.app,
			this.settings.templatePath,
		);

		// Initialize Ollama service
		const ollamaService = new OllamaService(this.settings.ollamaModel);

		// Process each book individually with its own language detection
		for (const [bookTitle, chapters] of content) {
			console.log(`\n📖 PROCESSING BOOK: "${bookTitle}"`);
			
			const sanitizedBookName = sanitize(bookTitle);
			const fileName = normalizePath(
				`${this.settings.storageFolder}/${sanitizedBookName}.md`,
			);

			// Collect all highlights for THIS book, split by type
			const bookVocabularyWords: string[] = [];
			let totalHighlights = 0;
			let quoteCount = 0;
			for (const [chapterName, bookmarks] of chapters) {
				console.log(`   📂 Chapter "${chapterName.trim()}": ${bookmarks.length} highlight(s)`);
				for (const bookmark of bookmarks) {
					totalHighlights++;
					if (bookmark.color == 1) {
						bookVocabularyWords.push(bookmark.text);
					} else {
						quoteCount++;
					}
				}
			}
			console.log(`   📝 Total highlights from DB: ${totalHighlights} (${bookVocabularyWords.length} vocab, ${quoteCount} quotes)`);
			if (bookVocabularyWords.length > 0) {
				console.log(`   Vocabulary: ${bookVocabularyWords.join(', ')}`);
			}

			// Parse existing definitions from THIS book's markdown file
			const existingDefinitions = new Map<string, string>();
			const fileExists = await this.app.vault.adapter.exists(fileName);
			if (fileExists) {
				const existingContent = await this.app.vault.adapter.read(fileName);
				this.parseExistingDefinitions(existingContent, existingDefinitions);
				console.log(`   ♻️  Reusing ${existingDefinitions.size} existing definitions`);
			}

			// Filter out words that already have definitions
			const wordsNeedingDefinitions = bookVocabularyWords.filter(
				word => !existingDefinitions.has(word)
			);

			// Detect language for THIS book using ALL vocabulary words (not just new ones),
			// so language is correctly detected even when all definitions are cached.
			let detectedLanguage = "en";
			if (bookVocabularyWords.length > 0) {
				console.log(`   🔎 Detecting language from ${bookVocabularyWords.length} vocabulary words...`);
				detectedLanguage = OllamaService.detectLanguage(bookVocabularyWords);
				const langName = detectedLanguage === "fr" ? "French" : "English";
				console.log(`   🎯 DETECTED: ${langName.toUpperCase()}`);
			}
			if (wordsNeedingDefinitions.length > 0) {
				console.log(`   🆕 New words needing definitions: ${wordsNeedingDefinitions.join(', ')}`);
			} else {
				console.log(`   ✅ All ${bookVocabularyWords.length} definitions already cached`);
			}

			// Fetch definitions only for new words in THIS book
			let definitions = new Map<string, string>(existingDefinitions);
			if (this.settings.ollamaModel && wordsNeedingDefinitions.length > 0) {
				const langName = detectedLanguage === "fr" ? "French" : "English";
				console.log(`   🤖 Fetching ${wordsNeedingDefinitions.length} ${langName} definitions...`);
				new Notice(
					`Fetching ${langName} definitions for "${bookTitle}" (${wordsNeedingDefinitions.length} words)...`,
				);
				const newDefinitions = await ollamaService.getVocabularyDefinitions(
					wordsNeedingDefinitions,
					detectedLanguage,
				);
				// Merge new definitions with existing ones
				for (const [word, definition] of newDefinitions) {
					definitions.set(word, definition);
				}
			}

			const details = await service.getBookDetailsFromBookTitle(bookTitle);

			// Always (re)generate the file from the template.
			// `chapters` contains ALL highlights from the database and
			// `definitions` contains both previously-cached and newly-fetched
			// definitions, so the output is always complete and consistent.
			console.log(`   💾 ${fileExists ? 'Regenerating' : 'Creating'} file with language: ${detectedLanguage}`);
			const generatedContent = applyTemplateTransformations(template, chapters, details, definitions, detectedLanguage);
			console.log(`   📋 Frontmatter check: ${generatedContent.substring(0, 100)}`);

			let finalContent = generatedContent;
			if (fileExists) {
				const existingContent = await this.app.vault.adapter.read(fileName);
				const userContent = this.extractUserContent(existingContent);
				if (userContent.size > 0 || userContent.has('__trailing__')) {
					finalContent = this.reinsertUserContent(generatedContent, userContent);
					const preservedChapters = [...userContent.keys()].filter(k => k !== '__trailing__');
					console.log(`   📌 Preserved user content in ${preservedChapters.length} chapter(s)`);
				}
			}

			await this.app.vault.adapter.write(
				fileName,
				finalContent,
			);
			console.log(`   ✅ Completed: ${fileName}`);
		}
	}

	private parseExistingDefinitions(
		content: string,
		definitions: Map<string, string>
	): void {
		// Match vocabulary format: - word ::: definition
		const vocabularyRegex = /^-\s+(.+?)\s+:::\s+(.+)$/gm;
		let match;
		
		while ((match = vocabularyRegex.exec(content)) !== null) {
			const word = match[1].trim();
			const definition = match[2].trim();
			definitions.set(word, definition);
		}
	}

	/**
	 * Extracts user-added content from an existing markdown file.
	 * User content is anything between `%% kobo-highlights-end %%` and the next
	 * `## ` chapter header (or end of file). Returns a Map keyed by chapter name.
	 * Trailing content after the last chapter is stored under '__trailing__'.
	 */
	private extractUserContent(existingContent: string): Map<string, string> {
		const userContent = new Map<string, string>();
		const lines = existingContent.split('\n');

		let currentChapter = '';
		let afterAutoEnd = false;
		let userLines: string[] = [];

		for (const line of lines) {
			// Detect chapter headers
			if (line.match(/^##\s+/)) {
				// Save accumulated user content for previous chapter
				if (currentChapter && userLines.length > 0) {
					const trimmed = userLines.join('\n').trim();
					if (trimmed) {
						userContent.set(currentChapter, trimmed);
					}
				}
				currentChapter = line.replace(/^##\s+/, '').trim();
				userLines = [];
				afterAutoEnd = false;
				continue;
			}

			// Detect end-of-auto marker
			if (line.includes('kobo-highlights-end')) {
				afterAutoEnd = true;
				continue;
			}

			// Detect start-of-auto marker (stop collecting user content)
			if (line.includes('kobo-highlights-start')) {
				afterAutoEnd = false;
				continue;
			}

			// Collect user content (lines after the auto end marker)
			if (afterAutoEnd && currentChapter) {
				userLines.push(line);
			}
		}

		// Save last chapter's user content (or trailing content)
		if (userLines.length > 0) {
			const trimmed = userLines.join('\n').trim();
			if (trimmed) {
				if (currentChapter) {
					userContent.set(currentChapter, trimmed);
				} else {
					userContent.set('__trailing__', trimmed);
				}
			}
		}

		return userContent;
	}

	/**
	 * Re-inserts preserved user content into newly generated content.
	 * For each chapter, user content is placed after `%% kobo-highlights-end %%`.
	 */
	private reinsertUserContent(
		generatedContent: string,
		userContent: Map<string, string>,
	): string {
		const lines = generatedContent.split('\n');
		const result: string[] = [];
		let currentChapter = '';

		for (const line of lines) {
			if (line.match(/^##\s+/)) {
				currentChapter = line.replace(/^##\s+/, '').trim();
			}

			result.push(line);

			// After each chapter's auto-end marker, insert preserved user content
			if (line.includes('kobo-highlights-end') && currentChapter) {
				const preserved = userContent.get(currentChapter);
				if (preserved) {
					result.push('');
					result.push(preserved);
				}
			}
		}

		// Append trailing user content (content not belonging to any chapter)
		const trailing = userContent.get('__trailing__');
		if (trailing) {
			result.push('');
			result.push(trailing);
		}

		return result.join('\n');
	}



	onOpen() {
		const { contentEl } = this;

		this.goButtonEl = contentEl.createEl("button");
		this.goButtonEl.textContent = "Extract";
		this.goButtonEl.disabled = true;
		this.goButtonEl.setAttr("style", "background-color: red; color: white");
		this.goButtonEl.addEventListener("click", async () => {
			try {
				new Notice("Extracting highlights...");
				await this.fetchHighlights();
				new Notice(
					`Extracted highlights from ${this.nrOfBooksExtracted} book${this.nrOfBooksExtracted !== 1 ? 's' : ''}!`,
				);
				this.close();
			} catch (error) {
				console.error("Error extracting highlights:", error);
				new Notice(
					`Failed to extract highlights: ${error instanceof Error ? error.message : 'Unknown error'}`,
				);
			}
		});

		this.inputFileEl = contentEl.createEl("input");
		this.inputFileEl.type = "file";
		this.inputFileEl.accept = ".sqlite";
		this.inputFileEl.addEventListener("change", (ev) => {
			const file = (ev.target as HTMLInputElement)?.files?.[0];
			if (!file) {
				return;
			}

			const reader = new FileReader();
			reader.onload = () => {
				this.fileBuffer = reader.result as ArrayBuffer;
				this.goButtonEl.disabled = false;
				this.goButtonEl.setAttr(
					"style",
					"background-color: green; color: black",
				);
				new Notice("Ready to extract!");
			};

			reader.onerror = () => {
				console.error("Failed to read file:", file.name);
				new Notice("Failed to read file. Please try again.");
			};

			reader.readAsArrayBuffer(file);
		});

		const heading = contentEl.createEl("h2");
		heading.textContent = "Sqlite file location";

		const description = contentEl.createEl("p");
		description.innerHTML =
			"Please select your <em>KoboReader.sqlite</em> file from a connected device";

		contentEl.appendChild(heading);
		contentEl.appendChild(description);
		contentEl.appendChild(this.inputFileEl);
		contentEl.appendChild(this.goButtonEl);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
