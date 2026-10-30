# Glossary of the interface

This glossary fixes the terms of the product in each language. A text of the catalogs uses these terms and no
synonyms. A new language adds one column. `i18n/README.md` tells how the catalogs work.

English is the source language. The German terms are the terms of the German interface of 2026-10-19, which the
German catalog keeps word for word.

## The map and its content

| English | German | Note |
|---|---|---|
| map | Map | The whole network of one person or team. German keeps the English word. |
| skill | Kenntnis (reader side), Skill (tools of the owner) | One entry of the map. German uses two words for the same thing, English uses one. |
| area | Bereich | The top level of a map, for example "Software development". |
| category | Kategorie | The level between an area and its skills. |
| cloud | Wolke | A category with its skills, as it shows on the map. |
| station | Station | An employer, an education or a private project, with its dates. A skill names the stations where it was used. |
| private project | privates Projekt | The kind of station for work outside an employer. |
| project | Projekt | A piece of work at one station. It lists the skills that it used. |
| base stack | Grundstack | A project that holds the base skills of a station. |
| standard skill | Standard-Skill | A skill that counts for every station from its station "Standard since" on. |
| indirect | indirekt | A station where a skill was used by others, not by the person. |
| rating | Bewertung | How well the person knows a skill. |
| time range | Zeitraum | The years that the map counts. Skills outside it fade. |
| line | Linie | A connection between two skills, two categories, or a skill and a category. |
| start point | Startpunkt | The place where an area starts in the layout. |
| example map | Beispiel | The read-only map on the start page. |
| template | Vorlage | The content that a new map starts with. |
| default set | Standardvorlage | The small template of a new map: three areas with two categories and two skills each. |
| map file | Map-Datei | The JSON file of a map, for export and import. Product format name `it-skills-map`. |

## The ratings

| English | German | Note |
|---|---|---|
| very good skills | sehr gute Kenntnisse | Rating 3, a star. |
| good skills | gute Kenntnisse | Rating 2. |
| basic skills | Grundkenntnisse | Rating 1. |
| used, not rated yet | eingesetzt, noch nicht bewertet | Rating 0. |
| used with AI, no routine of my own | mit KI eingesetzt, ohne eigene Routine | The marker KI. "AI" in English, "KI" in German. |

## The force menu

| English | German | Note |
|---|---|---|
| forces | Kräfte | The menu of the owner that sets the layout. |
| recalculate | neu berechnen | Runs the layout again. |
| configuration | Konfiguration | A saved set of the values of the force menu. |
| for readers | für Leser | The configuration that every other visitor sees. |
| values | Werte | The settings of the menu as one line of text. |
| spring | Feder | A force that pulls two nodes to a rest length. |
| rest length | Ruhelänge | The length of a spring without force. |
| charge | Ladung | A force that pushes nodes apart. |
| repulsion | Abstoßung | The factor of the charge between two kinds of nodes. |

## People and access

| English | German | Note |
|---|---|---|
| reader | Leser | A visitor who reads a map. Also the team role "reader". |
| owner | Inhaber | The team role with every right. On the map page, the person who owns the map. |
| editor | Bearbeiter | The team role that edits the maps of a team. |
| account | Konto | The registration on the server. |
| register | registrieren | Make an account. |
| sign in | anmelden | Not "log in". |
| sign out | abmelden | Not "log out". |
| team | Team | A group of accounts that share maps. |
| member | Mitglied | An account in a team. |
| invitation | Einladung | The mail that asks a person to join a team. |

## Sharing

| English | German | Note |
|---|---|---|
| share | teilen | The dialog that sets who reads a map. |
| visibility | Sichtbarkeit | Private, with link or public. |
| private | privat | Only the owner and the team see the map. |
| with link | per Link | Who has a read link sees the map. |
| public | öffentlich | Everybody sees the map under its public address. |
| read link | Link zum Lesen | A link that lets anybody read one map. |
| start map | Start-Map | The map that shows at the address of its owner, for example it-skills.net/anna. An owner has one. |
| embed | einbetten | Show a live map in a frame on another site. |
| export | exportieren | Save a map as a map file. |
| import | importieren | Make a map from a map file. |
| download | herunterladen | Save a picture or a PDF of the map. |
| browser | Browser | Stage a keeps every map in the storage of this browser. |

## The pages and their tools

| English | German | Note |
|---|---|---|
| start page | Startseite | The page with the maps of this browser and the example map. |
| language | Sprache | The language of the interface. The dropdown in the header of every page picks it. |
| Home | Start | The link back to the start page, one word. |
| legal notice | Impressum | The page that German law asks for. |
| privacy notice | Datenschutz | The page on the data that the site keeps. |
| force menu | Kräftemenü | The menu of the forces. Its heading is "Forces" ("Kräfte"). |
| control | Regler | A slider of the force menu. |
| last state in this browser | letzter Stand im Browser | The values of the force menu that this browser keeps. |
| schema | Schema | The version of the format of saved values. |
| step | Stufe | One step of a control or of the ageing. |
| store | Speicher | The configuration store of a map ("Konfigurationsspeicher"). |
| storage | Speicher | The local storage of the browser. |
| experience ring | Erfahrungsring | The ring around a skill that shows how long it was used. |
| ageing | Ageing | The grey part of the experience ring for old use. German keeps the English word. |
| gradient | Farbverlauf | A line drawn from one area colour to the other. |
| opacity | Deckkraft | How much a line covers. |
| bend | Krümmung | How much a line curves. |
| lopsided | einseitig | A cloud whose skills sit on one side. |
| hit | Treffer | A skill that the search finds. |
| note | Hinweis | The note of a standard skill, and the note of a station. |
| description | Beschreibung | The text of a station. |
| kind | Art | The kind of a station: employer, education or private project. |
| short name | Kurzname | The short name of a station in the chips and lines. |
| project database | Projektdatenbank | Where the projects of a map live. |
| CV | Lebenslauf | His CV. The ratings of his map come from it. |
| session | Sitzung | The time between sign in and sign out. |
| write conflict | Schreibkonflikt | A change that another tab or person made first. |
| site data | Website-Daten | What a browser keeps for a site. Blocked site data means no storage. |
| address | Adresse | The address of a page or a map. The handle of an account is its "name" in the address. |
| embed code | Code zum Einbetten | The HTML that puts a map into a frame on another site. |
| website | Website | Another site that embeds a map. |
| e-mail | E-Mail | Also "e-mail address" ("E-Mail-Adresse"). |
| collection | Sammlung | A group of documents in a map file. |
| document | Dokument | One entry of a collection. |

English uses British spelling (colour, centre, favourite), because its locale is `en-GB`.
