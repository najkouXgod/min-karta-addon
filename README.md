# Min karta GPX

Ett Chrome-tillägg som gör det möjligt att importera och exportera GPX-rutter i Lantmäteriets **Min karta**.

> **Observera:** Detta projekt är fristående och är inte utvecklat, godkänt eller underhållet av Lantmäteriet.

## Varför finns tillägget?

Lantmäteriets Min karta har ett mycket bra och detaljerat kartunderlag, men saknar stöd för att exportera ritade linjer som GPX-filer.

Min karta GPX skapades för att göra det enklare att:

* rita en rutt i Min karta,
* exportera rutten som GPX,
* lägga till höjddata i GPX-filen,
* exportera flera linjer tillsammans,
* importera en befintlig GPX-fil och visa den i Min karta.

Projektet är fortfarande i beta, men de viktigaste funktionerna fungerar.

## Funktioner

* Exportera ritade linjer som GPX
* Exportera en eller flera linjer i samma fil
* Namnge spår och GPX-filer
* Lägg automatiskt till höjddata
* Hantera längre rutter genom att dela upp höjdhämtningen
* Importera GPX-spår till Min karta
* Markera valda linjer direkt i kartan

## Rita en linje

1. Öppna **Min karta**.
2. Öppna ritverktyget i verktygsmenyn till höger.
3. Klicka på penselikonen.
4. Kontrollera att **Linje** är valt.
5. Klicka där rutten ska börja.
6. Fortsätt med enkelklick längs sträckan.
7. Dubbelklicka där rutten ska sluta.

## Exportera linjer som GPX

1. Klicka på panelen **Min karta GPX**.
2. Klicka på **Uppdatera**.
3. En lista över kartans ritade linjer visas.
4. Markera linjerna som ska exporteras.
5. Ändra spårnamn och filnamn vid behov.
6. Klicka på **Exportera valda**.

Tillägget försöker automatiskt hämta höjddata från Min kartas höjdtjänst.

Om höjddata inte kan hämtas får du möjlighet att exportera GPX-filen utan höjddata.

## Importera en GPX-fil

1. Rita först en kort linje någonstans i kartan. Den används för att identifiera Min kartas linjelager.
2. Klicka på **Importera GPX**.
3. Välj en `.gpx`-fil från datorn.
4. GPX-spåret läggs till som en linje i kartan.
5. Klicka på **Uppdatera** för att visa den importerade linjen i tilläggets lista.

Den tillfälliga linjen kan därefter tas bort med Min kartas verktyg **Ta bort objekt**.

## Installation från GitHub

1. Ladda ner den senaste ZIP-filen från projektets releases.
2. Packa upp ZIP-filen.
3. Öppna `chrome://extensions` i Chrome.
4. Aktivera **Utvecklarläge**.
5. Klicka på **Läs in okomprimerat tillägg**.
6. Välj den uppackade mappen.
7. Öppna eller uppdatera Min karta.

## Kända begränsningar

* Tillägget är beroende av Min kartas interna struktur. En framtida uppdatering av Min karta kan därför tillfälligt göra att vissa funktioner slutar fungera.
* En vanlig linje kan behöva finnas i kartan innan den första GPX-filen importeras.
* Importerade waypoints och intressepunkter stöds ännu inte.
* Mycket stora GPX-filer kan ta en stund att importera eller bearbeta.
* Tillägget är för närvarande främst testat i Google Chrome.

## Integritet

Tillägget innehåller ingen annonsering eller spårning.

Rutter behandlas lokalt i webbläsaren. När höjddata hämtas skickas ruttens koordinater till den höjdtjänst som används av Lantmäteriets Min karta.

## Fel och förslag

Har du hittat ett fel eller har ett förslag på en ny funktion?

Skapa gärna ett ärende under projektets flik **Issues** och beskriv:

* vad du försökte göra,
* vad som hände,
* vad du förväntade dig skulle hända,
* vilken webbläsare du använde.

Skärmbilder och felmeddelanden uppskattas.
