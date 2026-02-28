import { Eta } from "eta";
import { BookDetails, ReadStatus, Bookmark } from "../database/interfaces";
import { chapter } from "../database/Highlight";

const eta = new Eta({ autoEscape: false, autoTrim: false });

// Kobo color codes: 1 = vocabulary, other values = quotes

export const defaultTemplate = `
---
cards-deck: <%= it.language === 'fr' ? 'Vocabulaire' : 'Vocabulary' %>
---

<% it.chapters.forEach(([chapterName, highlights]) => { -%>
## <%= chapterName.trim() %>

%% kobo-highlights-start %%
<% highlights.forEach((highlight) => { -%>
<% console.log('Template highlight:', highlight.text.substring(0, 20), 'color:', highlight.color, 'type:', typeof highlight.color); -%>
<% if (highlight.color == 1) { -%>
<% const definition = it.definitions.get(highlight.text) || '...'; -%>
- <%= highlight.text %> ::: <%= definition %>
<% } else { -%>
> Quote : <%= highlight.text %>
<% } -%>

<% if (highlight.note) { -%>
**Note:** <%= highlight.note %>

<% } -%>
<% }) -%>
%% kobo-highlights-end %%

<% }) %>
`;

export function applyTemplateTransformations(
	rawTemplate: string,
	chapters: Map<chapter, Bookmark[]>,
	bookDetails: BookDetails,
	definitions: Map<string, string>,
	language: string = "en",
): string {
	const chaptersArr = Array.from(chapters.entries());
	const rendered = eta.renderString(rawTemplate, {
		bookDetails,
		chapters: chaptersArr,
		ReadStatus,
		definitions,
		language,
	});

	if (rendered === null) {
		console.error(
			"Template rendering failed: eta.renderString returned null.",
		);

		return "Error: Template rendering failed. Check console for details.";
	}

	return rendered.trim();
}
