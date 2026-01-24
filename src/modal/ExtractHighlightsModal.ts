import { App, Modal, normalizePath, Notice } from "obsidian";
import { sanitize } from "sanitize-filename-ts";
import SqlJs from "sql.js";
import { binary } from "src/binaries/sql-wasm";
import { HighlightService } from "src/database/Highlight";
import { BookDetails, Bookmark } from "src/database/interfaces";
import { Repository } from "src/database/repository";
import { KoboHighlightsImporterSettings } from "src/settings/Settings";
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
		const template = await getTemplateContents(
			this.app,
			this.settings.templatePath,
		);

		for (const [bookTitle, chapters] of content) {
			const sanitizedBookName = sanitize(bookTitle);
			const fileName = normalizePath(
				`${this.settings.storageFolder}/${sanitizedBookName}.md`,
			);

			const details =
				await service.getBookDetailsFromBookTitle(bookTitle);

			const fileExists = await this.app.vault.adapter.exists(fileName);

			if (fileExists) {
				await this.mergeHighlightsToExistingFile(
					fileName,
					chapters,
					details,
				);
			} else {
				await this.app.vault.adapter.write(
					fileName,
					applyTemplateTransformations(template, chapters, details),
				);
			}
		}
	}

	private async mergeHighlightsToExistingFile(
		fileName: string,
		newChapters: Map<string, Bookmark[]>,
		details: BookDetails,
	) {
		const existingContent = await this.app.vault.adapter.read(fileName);
		const mergedContent = this.mergeHighlights(
			existingContent,
			newChapters,
			details,
		);
		await this.app.vault.adapter.write(fileName, mergedContent);
	}

	private mergeHighlights(
		existingContent: string,
		newChapters: Map<string, Bookmark[]>,
		_details: BookDetails,
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
						newHighlightsToAdd.push(`- [ ] **${highlight.text}** :: ... #card`);
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
