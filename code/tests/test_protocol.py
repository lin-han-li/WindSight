import unittest

from windsight.protocol import ProtocolValidationError, parse_turbine_upload


class ProtocolParserTests(unittest.TestCase):
    def test_parse_valid_payload(self):
        payload = {
            "node_id": "WIN_001",
            "sub": "2",
            "001": [1, 2, 3, 4],
            "002": [5, 6, 7, 8],
        }
        parsed = parse_turbine_upload(payload)
        self.assertEqual(parsed.node_id, "WIN_001")
        self.assertEqual(parsed.turbine_count, 2)
        self.assertEqual(parsed.turbines["001"].temperature, 4.0)

    def test_reject_missing_node_id(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"sub": "1", "001": [1, 2, 3, 4]})

    def test_reject_missing_turbine_key(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "2", "001": [1, 2, 3, 4]})

    def test_reject_extra_turbine_key(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload(
                {
                    "node_id": "WIN_001",
                    "sub": "1",
                    "001": [1, 2, 3, 4],
                    "002": [5, 6, 7, 8],
                }
            )

    def test_reject_bad_array_length(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "1", "001": [1, 2, 3]})

    def test_reject_sub_over_limit(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "65", "001": [1, 2, 3, 4]})

    def test_reject_non_numeric_value(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "1", "001": [1, 2, "x", 4]})

    def test_reject_non_integer_sub(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "abc", "001": [1, 2, 3, 4]})


if __name__ == "__main__":
    unittest.main()
