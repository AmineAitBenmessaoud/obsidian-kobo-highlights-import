export class OllamaService {
	private modelName: string;
	private baseUrl: string;

	constructor(modelName: string, baseUrl: string = "http://localhost:11434") {
		this.modelName = modelName;
		this.baseUrl = baseUrl;
	}

	// Improved language detection based on French characteristics
	static detectLanguage(words: string[]): string {
		if (words.length === 0) return "en";
		
		// Take up to 50 random words for better sampling
		const sampleSize = Math.min(50, words.length);
		const sampleWords = words.length <= sampleSize 
			? words 
			: this.getRandomSample(words, sampleSize);
		
		let wordsWithAccents = 0;
		let frenchScore = 0;
		let totalWords = 0;
		
		for (const word of sampleWords) {
			const lowerWord = word.toLowerCase().trim();
			
			// Skip very short words or punctuation
			if (lowerWord.length < 3) continue;
			
			totalWords++;
			let wordScore = 0;
			
			// Strong indicators: French accented characters
			const accentCount = (lowerWord.match(/[àâäæçéèêëïîôùûüÿœ]/g) || []).length;
			if (accentCount > 0) {
				wordsWithAccents++;
				wordScore += 2; // Any accent is a strong French signal
			}
			
			// French word endings common in vocabulary
			if (lowerWord.length > 4) {
				if (/eur$|euse$|eux$|oise$|ois$|aire$|elle$|ique$|able$|ible$/.test(lowerWord)) {
					wordScore += 1;
				}
			}
			
			frenchScore += wordScore;
		}
		
		if (totalWords === 0) return "en";
		
		// If 30% or more words have French accents, it's French
		const accentRatio = wordsWithAccents / totalWords;
		console.log(`   🔢 Detection stats: ${wordsWithAccents}/${totalWords} words with accents (${(accentRatio * 100).toFixed(1)}%), score: ${frenchScore}`);
		
		return accentRatio >= 0.3 ? "fr" : "en";
	}
	
	private static getRandomSample<T>(array: T[], size: number): T[] {
		const shuffled = [...array].sort(() => Math.random() - 0.5);
		return shuffled.slice(0, size);
	}

	async getVocabularyDefinition(word: string, language: string = "en"): Promise<string> {
		if (!this.modelName) {
			return "...";
		}

		try {
			// Adjust prompt based on language
			let prompt = "";
			if (language === "fr") {
				prompt = `Donne uniquement la définition du mot "${word}" en français. Maximum 2 phrases courtes. IMPORTANT : Ne répète JAMAIS le mot "${word}" dans ta réponse. Commence directement par la définition sans mentionner le mot.`;
			} else {
				prompt = `Provide only the definition of "${word}". Maximum 2 short sentences. IMPORTANT: NEVER repeat the word "${word}" in your response. Start directly with the definition without mentioning the word.`;
			}

			const response = await fetch(
				`${this.baseUrl}/api/generate`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: this.modelName,
						prompt: prompt,
						stream: false,
					}),
				},
			);

			if (!response.ok) {
				console.error(
					`Ollama API error for word "${word}":`,
					response.statusText,
				);
				return "...";
			}

			const data = await response.json();
			const definition = data.response?.trim();

			return definition || "...";
		} catch (error) {
			console.error(
				`Error fetching definition for "${word}":`,
				error,
			);
			return "...";
		}
	}

	async getVocabularyDefinitions(
		words: string[],
		language: string = "en",
	): Promise<Map<string, string>> {
		const definitions = new Map<string, string>();

		// Process all words in parallel - no rate limits with local Ollama!
		const langName = language === "fr" ? "French" : "English";
		console.log(`Fetching ${langName} definitions for ${words.length} vocabulary words using Ollama...`);
		console.log(`Processing all words in parallel for maximum speed...`);
		
		const promises = words.map((word) =>
			this.getVocabularyDefinition(word, language),
		);
		const results = await Promise.all(promises);

		words.forEach((word, index) => {
			definitions.set(word, results[index]);
		});

		console.log(`✅ All ${words.length} definitions fetched!`);

		return definitions;
	}
}
