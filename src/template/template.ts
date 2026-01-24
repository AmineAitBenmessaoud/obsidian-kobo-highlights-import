import { Eta } from "eta";
import { BookDetails, ReadStatus, Bookmark } from "../database/interfaces";
import { chapter } from "../database/Highlight";

const eta = new Eta({ autoEscape: false, autoTrim: false });

// Kobo color codes: 1 = vocabulary, other values = quotes

export const defaultTemplate = `
---
title: "<%= it.bookDetails.title %>"
author: <%= it.bookDetails.author %>
publisher: <%= it.bookDetails.publisher ?? '' %>
dateLastRead: <%= it.bookDetails.dateLastRead?.toISOString() ?? '' %>
readStatus: <%= it.bookDetails.readStatus ? it.ReadStatus[it.bookDetails.readStatus] : it.ReadStatus[it.ReadStatus.Unknown] %>
percentRead: <%= it.bookDetails.percentRead ?? '' %>
isbn: <%= it.bookDetails.isbn ?? '' %>
series: <%= it.bookDetails.series ?? '' %>
seriesNumber: <%= it.bookDetails.seriesNumber ?? '' %>
timeSpentReading: <%= it.bookDetails.timeSpentReading ?? '' %>
---

# <%= it.bookDetails.title %>

## Description

<%= it.bookDetails.description ?? '' %>

## Highlights

<% it.chapters.forEach(([chapterName, highlights]) => { -%>
## <%= chapterName.trim() %>

<% highlights.forEach((highlight) => { -%>
<% console.log('Template highlight:', highlight.text.substring(0, 20), 'color:', highlight.color, 'type:', typeof highlight.color); -%>
<% if (highlight.color == 1) { -%>
- [ ] **<%= highlight.text %>** :: ... #card
<% } else { -%>
> Quote : <%= highlight.text %>
<% } -%>

<% if (highlight.note) { -%>
**Note:** <%= highlight.note %>

<% } -%>
<% }) -%>
<% }) %>
`;

export function applyTemplateTransformations(
	rawTemplate: string,
	chapters: Map<chapter, Bookmark[]>,
	bookDetails: BookDetails,
): string {
	const chaptersArr = Array.from(chapters.entries());
	const rendered = eta.renderString(rawTemplate, {
		bookDetails,
		chapters: chaptersArr,
		ReadStatus,
	});

	if (rendered === null) {
		console.error(
			"Template rendering failed: eta.renderString returned null.",
		);

		return "Error: Template rendering failed. Check console for details.";
	}

	return rendered.trim();
}
