import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Exhibits } from "@/components/Exhibits";
import { Lifecycle } from "@/components/Lifecycle";
import { EvidenceRegistry } from "@/components/EvidenceRegistry";
import { TrackRecord } from "@/components/TrackRecord";
import { LiveDemo } from "@/components/LiveDemo";
import { Footer } from "@/components/Footer";

function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <Hero />
      <Exhibits />
      <Lifecycle />
      <EvidenceRegistry />
      <LiveDemo />
      <TrackRecord />
      <Footer />
    </div>
  );
}

export default App;
