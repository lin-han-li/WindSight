import unittest

from windsight.protocol import ProtocolValidationError, parse_turbine_upload


class ProtocolParserTests(unittest.TestCase):
    def test_parse_valid_payload(self):
        payload = {
            "node_id": "WIN_001",
            "sub": "2",
            "001": [1, 2, 3, 4],
            "002": [5, 5, 5, 5],
        }
        parsed = parse_turbine_upload(payload)
        self.assertEqual(parsed.node_id, "WIN_001")
        self.assertEqual(parsed.turbine_count, 2)
        self.assertAlmostEqual(parsed.turbines["001"].voltage, 50.0)
        self.assertAlmostEqual(parsed.turbines["001"].current, 2.0)
        self.assertAlmostEqual(parsed.turbines["001"].speed, 1500.0)
        self.assertAlmostEqual(parsed.turbines["001"].temperature, 80.0)
        self.assertAlmostEqual(parsed.turbines["002"].voltage, 250.0)
        self.assertAlmostEqual(parsed.turbines["002"].current, 5.0)
        self.assertAlmostEqual(parsed.turbines["002"].speed, 2500.0)
        self.assertAlmostEqual(parsed.turbines["002"].temperature, 100.0)

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

    def test_accept_packet_that_does_not_start_at_001(self):
        payload = {
            "node_id": "WIN_001",
            "sub": "6",
            "031": [1, 2, 3, 4],
            "032": [1, 2, 3, 4],
            "033": [1, 2, 3, 4],
            "034": [1, 2, 3, 4],
            "035": [1, 2, 3, 4],
            "036": [1, 2, 3, 4],
        }

        parsed = parse_turbine_upload(payload)

        self.assertEqual(parsed.turbine_count, 6)
        self.assertEqual(parsed.turbine_codes(), ["031", "032", "033", "034", "035", "036"])
        self.assertIn("036", parsed.turbines)

    def test_reject_sub_that_does_not_match_packet_key_count(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload(
                {
                    "node_id": "WIN_001",
                    "sub": "6",
                    "031": [1, 2, 3, 4],
                    "032": [1, 2, 3, 4],
                    "033": [1, 2, 3, 4],
                }
            )

    def test_reject_turbine_key_outside_range(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "1", "201": [1, 2, 3, 4]})

    def test_reject_non_turbine_payload_key(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "1", "031": [1, 2, 3, 4], "foo": 1})

    def test_accept_sub_at_200_limit(self):
        payload = {"node_id": "WIN_001", "sub": "200"}
        for index in range(1, 201):
            payload[f"{index:03d}"] = [1, 2, 3, 4]

        parsed = parse_turbine_upload(payload)

        self.assertEqual(parsed.turbine_count, 200)
        self.assertEqual(len(parsed.turbines), 200)
        self.assertIn("200", parsed.turbines)

    def test_reject_sub_over_limit(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "201", "001": [1, 2, 3, 4]})

    def test_reject_non_numeric_value(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "1", "001": [1, 2, "x", 4]})

    def test_reject_raw_sensor_value_outside_0_to_5v(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "1", "001": [1, 2, 5.1, 4]})

    def test_reject_non_integer_sub(self):
        with self.assertRaises(ProtocolValidationError):
            parse_turbine_upload({"node_id": "WIN_001", "sub": "abc", "001": [1, 2, 3, 4]})


if __name__ == "__main__":
    unittest.main()
