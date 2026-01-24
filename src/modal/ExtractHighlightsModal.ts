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

			// Collect vocabulary words for THIS book only
			const bookVocabularyWords: string[] = [];
			for (const [, bookmarks] of chapters) {
				for (const bookmark of bookmarks) {
					if (bookmark.color == 1) {
						bookVocabularyWords.push(bookmark.text);
					}
				}
			}
			console.log(`   📝 Found ${bookVocabularyWords.length} vocabulary words in this book`);
			if (bookVocabularyWords.length > 0) {
				console.log(`   Sample: ${bookVocabularyWords.slice(0, 5).join(', ')}${bookVocabularyWords.length > 5 ? '...' : ''}`);
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

			// Detect language for THIS book only
			let detectedLanguage = "en";
			if (wordsNeedingDefinitions.length > 0) {
				console.log(`   🔎 Detecting language from ${wordsNeedingDefinitions.length} new words...`);
				detectedLanguage = OllamaService.detectLanguage(wordsNeedingDefinitions);
				const langName = detectedLanguage === "fr" ? "French" : "English";
				console.log(`   🎯 DETECTED: ${langName.toUpperCase()}`);
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

			if (fileExists) {
				console.log(`   💾 Merging to existing file with language: ${detectedLanguage}`);
				await this.mergeHighlightsToExistingFile(
					fileName,
					chapters,
					details,
					definitions,
					detectedLanguage,
				);
			} else {
				console.log(`   💾 Creating new file with language: ${detectedLanguage}`);
				const content = applyTemplateTransformations(template, chapters, details, definitions, detectedLanguage);
				console.log(`   📋 Frontmatter check: ${content.substring(0, 100)}`);
				await this.app.vault.adapter.write(
					fileName,
					content,
				);
			}
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

	private async mergeHighlightsToExistingFile(
		fileName: string,
		newChapters: Map<string, Bookmark[]>,
		details: BookDetails,
		definitions: Map<string, string>,
		language: string,
	) {
		const existingContent = await this.app.vault.adapter.read(fileName);
		const mergedContent = this.mergeHighlights(
			existingContent,
			newChapters,
			details,
			definitions,
			language,
		);
		await this.app.vault.adapter.write(fileName, mergedContent);
	}

	private mergeHighlights(
		existingContent: string,
		newChapters: Map<string, Bookmark[]>,
		_details: BookDetails,
		definitions: Map<string, string>,
		_language: string,
	): string {
		const lines = existingContent.split("\n");
		const result: string[] = [];
		let inHighlightsSection = false;
		let currentChapter = "";
		const existingHighlights = new Map<string, Set<string>>();

		// Parse existing content to extract highlights
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Detect when we enter the Highlights section
			if (line.match(/^##\s+Highlights\s*$/)) {
				inHighlightsSection = true;
				result.push(line);
				continue;
			}

			// Detect chapter headers within highlights
			if (inHighlightsSection && line.match(/^##\s+/)) {
				currentChapter = line.replace(/^##\s+/, "").trim();
				if (!existingHighlights.has(currentChapter)) {
					existingHighlights.set(currentChapter, new Set());
				}
			}

			// Store existing highlight text
			if (
				inHighlightsSection &&
				currentChapter &&
				line.trim() &&
				!line.match(/^(##|#|\*Created:|\*\*Note:\*\*)/)
			) {
				existingHighlights.get(currentChapter)?.add(line.trim());
			}

			result.push(line);
		}

		// If no Highlights section exists, add it before adding new highlights
		if (!inHighlightsSection) {
			result.push("", "## Highlights", "");
		}

		// Add new highlights for each chapter
		for (const [chapterName, highlights] of newChapters) {
			const trimmedChapterName = chapterName.trim();
			const chapterHighlights =
				existingHighlights.get(trimmedChapterName) || new Set();

			// Find or create chapter section
			const chapterHeaderIndex = result.findIndex(
				(line, idx) =>
					idx > 0 &&
					line.match(/^##\s+/) &&
					line.replace(/^##\s+/, "").trim() === trimmedChapterName,
			);

			const newHighlightsToAdd: string[] = [];

			for (const highlight of highlights) {
				// Only add if this highlight text doesn't already exist
				if (!chapterHighlights.has(highlight.text)) {
					// Add highlight with type indicator based on color
					if (highlight.color == 1) {
						const definition = definitions.get(highlight.text) || "...";
						newHighlightsToAdd.push(`- [ ] **${highlight.text}** :: ${definition} #card`);
					} else {
						newHighlightsToAdd.push(`> Quote : ${highlight.text}`);
					}
					newHighlightsToAdd.push("");
					if (highlight.note) {
						newHighlightsToAdd.push(`**Note:** ${highlight.note}`);
						newHighlightsToAdd.push("");
					}
				}
			}

			// Add new highlights to chapter
			if (newHighlightsToAdd.length > 0) {
				if (chapterHeaderIndex !== -1) {
					// Chapter exists, find where to insert new highlights
					let insertIndex = chapterHeaderIndex + 1;
					// Skip to the end of existing highlights in this chapter
					while (
						insertIndex < result.length &&
						!result[insertIndex].match(/^##\s+/)
					) {
						insertIndex++;
					}
					result.splice(insertIndex, 0, ...newHighlightsToAdd);
				} else {
					// Chapter doesn't exist, add it at the end
					result.push(`## ${trimmedChapterName}`, "");
					result.push(...newHighlightsToAdd);
				}
			}
		}

		return result.join("\n");
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
