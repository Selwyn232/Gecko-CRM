import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHead } from "../components/ui";

/** Handleiding: het proces van offerte tot afronding, per rol, en waar je wat vindt. */
const STEPS: { who: string; title: string; text: string; link?: [string, string] }[] = [
  { who: "Verkoop", title: "Offerte", text: "Maak een klant en offerte (of Greenteam doet dat in het verkoopportaal). Definitief maken zet prijzen, btw, kostprijs en fee vast. Versturen ter akkoord: de klant krijgt een persoonlijke link en bevestigt met een code per e-mail.", link: ["/offertes", "Offertes"] },
  { who: "Klant", title: "Akkoord → project", text: "Na akkoord ontstaat automatisch het project. De klant krijgt een bevestiging met de volledige offerte en bedenktijd, en kan zijn project volgen in Mijn Gecko (/mijn).", link: ["/projecten", "Projecten"] },
  { who: "Planner", title: "Schouw inplannen", text: "Op het project → Schouw plannen. Bovenaan staat een voorstel (snel, rustige partner, al in de buurt). Na inplannen gaat de aanbetalingsfactuur (70%) automatisch uit; die moet vóór de schouw betaald zijn. Klant krijgt een bevestiging en een dag vooraf een herinnering.", link: ["/planning", "Planning"] },
  { who: "Installateur", title: "Schouwrapport", text: "In het partnerportaal: checklist, foto's en eventueel meerwerk (alleen uit de catalogus). Gemist meerwerk is voor rekening van de installateur." },
  { who: "Planner", title: "Rapport beoordelen", text: "Planning → Rapporten (of Mijn werk). Goedkeuren laat het project doorgaan; met meerwerk ontstaat een meerwerk-offerte die je ter akkoord naar de klant stuurt. Afkeuren: de installateur dient opnieuw in.", link: ["/planning", "Planning"] },
  { who: "Planner", title: "Installatie inplannen", text: "Bij dezelfde installateur, hele dag(en). Klant krijgt bevestiging en herinnering." },
  { who: "Installateur", title: "Oplevering", text: "Opleverrapport met serienummers, foto's en handtekening van de klant. Na goedkeuring gaat de eindfactuur (rest + meerwerk) automatisch uit." },
  { who: "Finance", title: "Betaling en aanmaningen", text: "Betalingen via iDEAL (Mollie) of overschrijving. Herinnering, 14-dagenbrief (WIK) en overdracht incasso gaan automatisch; pauzeren kan per factuur.", link: ["/facturen", "Facturen"] },
  { who: "Finance", title: "Selfbilling", text: "Na betaalde aanbetaling: fee Greenteam; na betaalde eindfactuur: installateur (min boetes). Concept → definitief → partner geeft akkoord per e-mail → uitbetalen.", link: ["/selfbilling", "Selfbilling"] },
  { who: "Iedereen", title: "Afronden en nacalculatie", text: "Na de eindbetaling is het project afgerond. Op het project zie je voor- en nacalculatie; Rapportages geeft het overzicht.", link: ["/rapportages", "Rapportages"] },
];

const FAQ: [string, string][] = [
  ["Waar begin ik 's ochtends?", "Op Mijn werk: alles wat aandacht nodig heeft, met links. Het belletje linksonder toont nieuwe meldingen."],
  ["Hoe vind ik snel een klant?", "Druk op / of gebruik de zoekbalk: naam, e-mail, telefoon, postcode, adres of een nummer (K-, P-, O-, F-)."],
  ["De klant belt en wil iets anders.", "Leg het vast als belnotitie in de tijdlijn op de klantkaart, en maak zo nodig een taak voor een collega."],
  ["Een afspraak gaat niet door.", "Op het project of in Planning → Annuleren. Kwam de installateur niet opdagen? Kies 'Partner niet gekomen': de boete (€ 250) wordt automatisch vastgelegd."],
  ["De klant wil annuleren.", "Op het project → status Geannuleerd. Je ziet vooraf wat er gebeurt en kiest welke facturen worden gecrediteerd."],
  ["Een klant vraagt welke gegevens we hebben, of wil worden verwijderd.", "Klantkaart → Privacy (AVG): inzage-export of anonimiseren. Facturen blijven 7 jaar bewaard."],
  ["Welke e-mails krijgt de klant?", "Zie Klantberichten: per status en bij afspraken. Teksten zijn aan te passen, met voorbeeld en testmail."],
  ["Hoe test ik zonder echte klant?", "Pagina Testen (beheerders): testmodus aan en een testscenario maken; alle mails gaan naar je eigen adres."],
];

export function HelpPage() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <>
      <PageHead title="Handleiding" sub="Hoe het werkt, van offerte tot afronding. Klik op een stap voor uitleg." />
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Het proces</h2>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={i} className="clickable" onClick={() => setOpen(open === i ? null : i)} style={{ cursor: "pointer" }}>
              <div>
                <div className="who">{s.who}</div>
                <strong>{s.title}</strong>
                {open === i && <div className="muted" style={{ marginTop: 4 }}>{s.text}</div>}
              </div>
              {s.link && open === i && <Link className="btn small" to={s.link[0]} onClick={(e) => e.stopPropagation()}>{s.link[1]}</Link>}
            </li>
          ))}
        </ol>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Veelgestelde vragen</h2>
        {FAQ.map(([q, a]) => (
          <details key={q} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <summary style={{ cursor: "pointer", fontWeight: 500 }}>{q}</summary>
            <p style={{ margin: "6px 0 0" }}>{a}</p>
          </details>
        ))}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Portalen</h2>
        <ul style={{ paddingLeft: 18, margin: 0 }}>
          <li><strong>Installateurs</strong> loggen in op hetzelfde adres en zien alleen hun eigen afspraken, beschikbaarheid, werkgebied en uitbetalingen.</li>
          <li><strong>Greenteam-adviseurs</strong> (rol Verkooppartner) zien alleen hun eigen klanten, offertes en fee.</li>
          <li><strong>Klanten</strong> gebruiken Mijn Gecko op <code>/mijn</code>: inloggen met een link per e-mail. Nodig ze uit via de klantkaart.</li>
        </ul>
      </div>
    </>
  );
}
