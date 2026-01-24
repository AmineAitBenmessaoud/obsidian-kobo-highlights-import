import { App, PluginSettingTab, Setting } from "obsidian";
import KoboHighlightsImporter from "src/main";
import { FileSuggestor } from "./suggestors/FileSuggestor";
import { FolderSuggestor } from "./suggestors/FolderSuggestor";

export const DEFAULT_SETTINGS: KoboHighlightsImporterSettings = {
	storageFolder: "",
	sortByChapterProgress: false,
	templatePath: "",
	importAllBooks: false,
	ollamaModel: "",
};

export interface KoboHighlightsImporterSettings {
	storageFolder: string;
	sortByChapterProgress: boolean;
	templatePath: string;
	importAllBooks: boolean;
	ollamaModel: string;
}

export class KoboHighlightsImporterSettingsTab extends PluginSettingTab {
	constructor(
		public app: App,
		private plugin: KoboHighlightsImporter,
	) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();
		this.containerEl.createEl("h2", { text: this.plugin.manifest.name });

		this.addDestinationFolder();
		this.addTemplatePath();
		this.addSortByChapterProgress();
		this.addImportAllBooks();
		this.addOllamaModel();
	}

	private addDestinationFolder(): void {
		new Setting(this.containerEl)
			.setName("Destination folder")
			.setDesc("Where to save your imported highlights")
			.addSearch((cb) => {
				new FolderSuggestor(this.app, cb.inputEl);
				cb.setPlaceholder("Example: folder1/folder2")
					.setValue(this.plugin.settings.storageFolder)
				.onChange(async (newFolder) => {
					this.plugin.settings.storageFolder = newFolder;
					await this.plugin.saveSettings();
				});
			});
	}

	private addTemplatePath(): void {
		new Setting(this.containerEl)
			.setName("Template Path")
			.setDesc("Which template to use for extracted highlights")
			.addSearch((cb) => {
				new FileSuggestor(this.app, cb.inputEl);
				cb.setPlaceholder("Example: folder1/template")
					.setValue(this.plugin.settings.templatePath)
				.onChange(async (newTemplatePath) => {
					this.plugin.settings.templatePath = newTemplatePath;
					await this.plugin.saveSettings();
				});
			});
	}

	private addSortByChapterProgress(): void {
		const desc = document.createDocumentFragment();
		desc.append(
			"Turn on to sort highlights by chapter progess. If turned off, highlights are sorted by creation date and time.",
		);

		new Setting(this.containerEl)
			.setName("Sort by chapter progress")
			.setDesc(desc)
			.addToggle((cb) => {
				cb.setValue(
					this.plugin.settings.sortByChapterProgress,
				).onChange(async (toggle) => {
					this.plugin.settings.sortByChapterProgress = toggle;
					await this.plugin.saveSettings();
				});
			});
	}

	private addImportAllBooks(): void {
		const desc = document.createDocumentFragment();
		desc.append(
			"When enabled, import information for all books from your Kobo device, not just books with highlights.",
			desc.createEl("br"),
			"This will include reading progress, status, and other metadata for every book.",
		);

		new Setting(this.containerEl)
			.setName("Import all books")
			.setDesc(desc)
			.addToggle((cb) => {
				cb.setValue(this.plugin.settings.importAllBooks).onChange(
					async (toggle) => {
						this.plugin.settings.importAllBooks = toggle;
						await this.plugin.saveSettings();
					},
				);
			});
	}
	private addOllamaModel(): void {
		new Setting(this.containerEl)
			.setName("Ollama Model")
			.setDesc("Name of the local Ollama model to use for vocabulary definitions (e.g., llama3.2, mistral, phi3). Make sure Ollama is running locally.")
			.addText((cb) => {
				cb.setPlaceholder("llama3.2")
					.setValue(this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
