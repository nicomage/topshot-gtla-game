export default function handler(req, res) {
  res.status(410).json({ message: 'Not used anymore.' });
}
