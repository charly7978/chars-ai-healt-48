import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import ComingSoon from "./pages/ComingSoon";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";

const enablePpgApp = import.meta.env.VITE_ENABLE_PPG_APP === "true";

const App = () => {
  return (
    <Router>
      <Routes>
        {enablePpgApp ? (
          <>
            <Route path="/" element={<Index />} />
            <Route path="*" element={<NotFound />} />
          </>
        ) : (
          <Route path="*" element={<ComingSoon />} />
        )}
      </Routes>
    </Router>
  );
};

export default App;
